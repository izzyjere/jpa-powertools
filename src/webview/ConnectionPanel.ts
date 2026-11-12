import * as vscode from 'vscode';
import { ConnectionStore, newConnectionId } from '../connections/ConnectionStore';
import { CancelledError, ConnectionError, SessionManager } from '../connections/SessionManager';
import { buildJdbcUrl, parseJdbcUrl } from '../db/jdbcUrl';
import { ConnectionDraft, draftToConfig, validateDraft } from '../model/connectionDraft';
import { ConnectionConfig, DIALECTS } from '../model/types';
import { findSpringDatasources } from '../project/projectScanner';
import { webviewHtml } from './html';

type FromWebview =
  | { type: 'ready' }
  | { type: 'test' | 'save'; draft: ConnectionDraft; password: string; passwordTouched: boolean }
  | { type: 'parseUrl'; url: string }
  | { type: 'buildUrl'; draft: ConnectionDraft }
  | { type: 'browse'; purpose: 'databaseFile' | 'driverJars' }
  | { type: 'cancel' };

/** Webview form for creating and editing connections. One panel per connection. */
export class ConnectionPanel {
  private static readonly open = new Map<string, ConnectionPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly id: string;
  private readonly existing: ConnectionConfig | undefined;

  static show(
    extensionUri: vscode.Uri,
    store: ConnectionStore,
    sessions: SessionManager,
    existing?: ConnectionConfig,
    prefill?: Partial<ConnectionDraft> & { password?: string },
    onSaved?: (config: ConnectionConfig) => void,
  ): void {
    const key = existing?.id ?? 'new';
    const current = ConnectionPanel.open.get(key);
    if (current && !prefill) {
      current.panel.reveal();
      return;
    }
    current?.panel.dispose();
    new ConnectionPanel(extensionUri, store, sessions, existing, prefill, onSaved);
  }

  private constructor(
    extensionUri: vscode.Uri,
    private readonly store: ConnectionStore,
    private readonly sessions: SessionManager,
    existing: ConnectionConfig | undefined,
    private readonly prefill: (Partial<ConnectionDraft> & { password?: string }) | undefined,
    private readonly onSaved?: (config: ConnectionConfig) => void,
  ) {
    this.existing = existing;
    this.id = existing?.id ?? newConnectionId();
    const key = existing?.id ?? 'new';
    this.panel = vscode.window.createWebviewPanel(
      'jpaPowertools.connection',
      existing ? `Edit ${existing.name}` : 'New Connection',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] },
    );
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'database.svg');
    this.panel.webview.html = webviewHtml(this.panel.webview, extensionUri, 'Connection', 'connection.js');
    this.panel.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m).catch(err => {
      this.post({ type: 'testResult', ok: false, message: (err as Error).message });
    }));
    this.panel.onDidDispose(() => {
      if (ConnectionPanel.open.get(key) === this) {
        ConnectionPanel.open.delete(key);
      }
    });
    ConnectionPanel.open.set(key, this);
  }

  private post(msg: unknown) {
    return this.panel.webview.postMessage(msg);
  }

  private async onMessage(m: FromWebview): Promise<void> {
    switch (m.type) {
      case 'ready': {
        const e = this.existing;
        const draft: Partial<ConnectionDraft> = e
          ? {
            kind: e.kind, name: e.name, host: e.host, port: e.port, database: e.database, user: e.user, ssl: e.ssl,
            savePassword: e.savePassword, jdbcUrl: e.jdbcUrl ?? '', driverJars: e.driverJars ?? [], driverClass: e.driverClass ?? '',
          }
          : { ...this.prefill };
        const hasSavedPassword = !!e && e.savePassword && (await this.store.getPassword(e.id)) !== undefined;
        this.post({
          type: 'init',
          mode: e ? 'edit' : 'create',
          draft,
          password: e ? '' : this.prefill?.password ?? '',
          hasSavedPassword,
          dialects: DIALECTS,
        });
        // Spring datasources are a convenience; load them after the form is interactive.
        if (!e) {
          const found = await findSpringDatasources().catch(() => []);
          this.post({ type: 'springSources', sources: found });
        }
        return;
      }
      case 'parseUrl':
        this.post({ type: 'urlParsed', url: m.url, parsed: parseJdbcUrl(m.url) ?? null });
        return;
      case 'buildUrl':
        this.post({ type: 'urlBuilt', url: buildJdbcUrl(draftToConfig(this.id, m.draft)) });
        return;
      case 'browse': {
        const uris = await vscode.window.showOpenDialog(m.purpose === 'driverJars'
          ? { canSelectMany: true, filters: { 'JDBC driver': ['jar'] }, openLabel: 'Use Driver' }
          : { canSelectMany: false, openLabel: 'Use Database File' });
        if (uris?.length) {
          this.post({ type: 'browsed', purpose: m.purpose, paths: uris.map(u => u.fsPath) });
        }
        return;
      }
      case 'cancel':
        this.panel.dispose();
        return;
      case 'test':
      case 'save': {
        const errors = validateDraft(m.draft);
        if (Object.keys(errors).length) {
          this.post({ type: 'validation', errors });
          return;
        }
        const config = draftToConfig(this.id, m.draft);
        const password = m.passwordTouched || !this.existing ? m.password : await this.store.getPassword(this.id);
        if (m.type === 'test') {
          await this.test(config, password);
        } else {
          await this.save(config, m.passwordTouched || !this.existing ? m.password : undefined);
        }
        return;
      }
    }
  }

  private async test(config: ConnectionConfig, password: string | undefined) {
    this.post({ type: 'busy', action: 'test' });
    try {
      const version = await this.sessions.test(config, password);
      this.post({ type: 'testResult', ok: true, message: `Connected: ${version}` });
    } catch (err) {
      if (err instanceof CancelledError) {
        this.post({ type: 'testResult', ok: false, message: 'Cancelled.' });
        return;
      }
      const message = err instanceof ConnectionError ? err.message : (err as Error).message;
      this.post({ type: 'testResult', ok: false, message });
    }
  }

  private async save(config: ConnectionConfig, password: string | undefined) {
    const nameTaken = this.store.list().some(c => c.id !== config.id && c.name.toLowerCase() === config.name.toLowerCase());
    if (nameTaken) {
      this.post({ type: 'validation', errors: { name: `A connection named "${config.name}" already exists` } });
      return;
    }
    if (this.existing) {
      await this.sessions.disconnect(config.id);
    }
    // Passwords that are not saved still get used for this VS Code session via the prompt cache.
    await this.store.save(config, config.savePassword ? password : undefined);
    if (!config.savePassword && password) {
      this.sessions.rememberPassword(config.id, password);
    }
    this.panel.dispose();
    this.onSaved?.(config);
  }
}
