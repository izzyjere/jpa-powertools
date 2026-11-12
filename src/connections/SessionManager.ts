import * as vscode from 'vscode';
import { openSession, testConnection } from '../db/connect';
import { DbSession, friendlyError } from '../db/session';
import { ConnectionConfig, dialect } from '../model/types';
import { ConnectionStore } from './ConnectionStore';
import type { JdbcEnvironment } from './JdbcEnvironment';

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
  }
}

/** Error with a message that is safe and useful to show to the user. */
export class ConnectionError extends Error {}

/** Opens, caches and disposes database sessions; prompts for passwords that are not saved. */
export class SessionManager implements vscode.Disposable {
  private readonly sessions = new Map<string, DbSession>();
  private readonly pending = new Map<string, Promise<DbSession>>();
  /** Passwords entered at a prompt, kept in memory for this VS Code session only. */
  private readonly promptedPasswords = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<string>();
  /** Fires with the connection id whenever a session opens or closes. */
  readonly onDidChangeState = this.emitter.event;

  constructor(private readonly store: ConnectionStore, private readonly jdbc: JdbcEnvironment) {}

  /** Tests settings without caching a session. Throws `ConnectionError` with a friendly message. */
  async test(config: ConnectionConfig, password: string | undefined): Promise<string> {
    const runtime = dialect(config.kind).driver === 'jdbc' ? await this.jdbc.runtimeFor(config) : undefined;
    try {
      return await testConnection(config, password, runtime);
    } catch (err) {
      throw new ConnectionError(friendlyError(err, config));
    }
  }

  /** Keeps a password in memory for this VS Code session (connections that don't save passwords). */
  rememberPassword(id: string, password: string): void {
    this.promptedPasswords.set(id, password);
  }

  isConnected(id: string): boolean {
    return this.sessions.has(id);
  }

  async get(config: ConnectionConfig): Promise<DbSession> {
    const existing = this.sessions.get(config.id);
    if (existing) {
      return existing;
    }
    let p = this.pending.get(config.id);
    if (!p) {
      p = this.open(config).finally(() => this.pending.delete(config.id));
      this.pending.set(config.id, p);
    }
    return p;
  }

  private async open(config: ConnectionConfig): Promise<DbSession> {
    let password = config.savePassword ? await this.store.getPassword(config.id) : this.promptedPasswords.get(config.id);
    let prompted = false;
    if (password === undefined) {
      prompted = true;
      password = await vscode.window.showInputBox({
        title: `Connect to ${config.name}`,
        prompt: `Password for ${config.user}@${config.host}`,
        password: true,
        ignoreFocusOut: true,
      });
      if (password === undefined) {
        throw new CancelledError();
      }
    }
    const runtime = dialect(config.kind).driver === 'jdbc' ? await this.jdbc.runtimeFor(config) : undefined;
    const session = openSession(config, password, runtime);
    try {
      await session.serverVersion();
    } catch (err) {
      await session.close();
      this.promptedPasswords.delete(config.id);
      throw new ConnectionError(friendlyError(err, config));
    }
    if (prompted) {
      if (config.savePassword) {
        await this.store.save(config, password);
      } else {
        this.promptedPasswords.set(config.id, password);
      }
    }
    this.sessions.set(config.id, session);
    this.emitter.fire(config.id);
    return session;
  }

  async disconnect(id: string): Promise<void> {
    const s = this.sessions.get(id);
    this.sessions.delete(id);
    this.promptedPasswords.delete(id);
    if (s) {
      await s.close();
      this.emitter.fire(id);
    }
  }

  async dispose(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(all.map(s => s.close()));
    this.emitter.dispose();
  }
}
