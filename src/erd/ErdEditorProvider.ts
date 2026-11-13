import * as path from 'path';
import * as vscode from 'vscode';
import { ConnectionStore } from '../connections/ConnectionStore';
import { SessionManager } from '../connections/SessionManager';
import { JpqlService } from '../jpql/JpqlService';
import { DIALECTS, DbKind, dialect } from '../model/types';
import { scanProject } from '../project/projectScanner';
import { GeneratorPanel, TableSource } from '../webview/GeneratorPanel';
import { webviewHtml } from '../webview/html';
import { generateDdl, nextMigrationName } from './ddl';
import {
  ERD_COLORS, ERD_TYPES, ErdDocument, foldIdentifier, fromEntityModel, fromTables, mergeLayout, parseDocument, serializeDocument, toTables,
} from './erdModel';

type FromWebview =
  | { type: 'ready' }
  | { type: 'edit'; doc: ErdDocument; label: string }
  | { type: 'viewChanged'; view: string }
  | { type: 'generateEntities' }
  | { type: 'generateSql'; dialect: DbKind }
  | { type: 'export'; format: 'svg' | 'png'; data: string }
  | { type: 'sync' }
  | { type: 'openAsText' };

const VIEW_KEY = 'jpaPowertools.erdView';

/** Custom editor for `*.erd.json`: the JSON document is the source of truth, so save, undo and redo come from VS Code. */
export class ErdEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'jpaPowertools.erd';
  /** Open editors by document URI, for tests. */
  static readonly editors = new Map<string, { panel: vscode.WebviewPanel; posted: Map<string, unknown>; handle: (m: FromWebview) => Promise<void> }>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly jpql: JpqlService,
    private readonly store: ConnectionStore,
    private readonly sessions: SessionManager,
  ) {}

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    panel.webview.html = webviewHtml(panel.webview, this.context.extensionUri, 'ER Diagram', 'erd.js', ['erd-layout.js']);
    const posted = new Map<string, unknown>();
    let lastWritten: string | undefined;

    const post = (msg: { type: string; [k: string]: unknown }) => {
      posted.set(msg.type, msg);
      return panel.webview.postMessage(msg);
    };
    const send = (type: 'load' | 'doc') => {
      let doc: ErdDocument;
      try {
        doc = parseDocument(document.getText());
      } catch (e) {
        post({ type: 'error', message: (e as Error).message });
        return;
      }
      post({ type, doc, meta: this.meta(doc, document.uri) });
    };

    const handle = async (m: FromWebview): Promise<void> => {
      switch (m.type) {
        case 'ready':
          send('load');
          return;
        case 'edit': {
          const text = serializeDocument(m.doc);
          if (text === document.getText()) {
            return;
          }
          lastWritten = text;
          const edit = new vscode.WorkspaceEdit();
          edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text);
          await vscode.workspace.applyEdit(edit);
          return;
        }
        case 'viewChanged':
          await this.context.workspaceState.update(`${VIEW_KEY}:${document.uri}`, m.view);
          return;
        case 'generateEntities':
          this.generateEntities(document);
          return;
        case 'generateSql':
          await this.generateSql(document, m.dialect);
          return;
        case 'export':
          await this.export(document, m.format, m.data);
          return;
        case 'sync':
          await this.sync(document, post);
          return;
        case 'openAsText':
          await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
          return;
      }
    };

    const subs = [
      panel.webview.onDidReceiveMessage((m: FromWebview) => handle(m).catch(err => post({ type: 'status', message: (err as Error).message, kind: 'error' }))),
      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.uri.toString() === document.uri.toString() && e.contentChanges.length && document.getText() !== lastWritten) {
          send('doc'); // undo, redo or an edit in a text editor
        }
      }),
    ];
    ErdEditorProvider.editors.set(document.uri.toString(), { panel, posted, handle });
    panel.onDidDispose(() => {
      subs.forEach(s => s.dispose());
      ErdEditorProvider.editors.delete(document.uri.toString());
    });
  }

  private meta(doc: ErdDocument, uri: vscode.Uri) {
    const source = doc.source;
    return {
      types: ERD_TYPES,
      dialects: DIALECTS.filter(d => d.kind !== 'jdbc').map(d => ({ kind: d.kind, label: d.label })),
      colors: ERD_COLORS,
      canSync: !!source,
      syncHint: source?.type === 'database' ? `Reload tables from ${source.connection} · ${source.schema}` : 'Reload from the @Entity classes in this workspace',
      view: this.context.workspaceState.get<string>(`${VIEW_KEY}:${uri}`),
    };
  }

  private generateEntities(document: vscode.TextDocument): void {
    const read = () => parseDocument(document.getText());
    const doc = read();
    const { tables, classNames } = toTables(doc);
    const schemas = tables.map(t => t.schema).filter(Boolean);
    const main = schemas.sort((a, b) => schemas.filter(x => x === b).length - schemas.filter(x => x === a).length)[0] ?? '';
    const source: TableSource = {
      key: `erd|${document.uri}`,
      label: doc.name,
      schema: '',
      kind: doc.dialect,
      load: async () => toTables(read()).tables,
      defaultSchema: async () => foldIdentifier(main, doc.dialect),
      classNames,
      describeError: err => (err as Error).message,
    };
    GeneratorPanel.show(this.context, source, tables.filter(t => t.kind === 'table').map(t => t.name));
  }

  private async generateSql(document: vscode.TextDocument, kind: DbKind): Promise<void> {
    const doc = parseDocument(document.getText());
    const ddl = generateDdl(doc, kind);
    const sqlDoc = await vscode.workspace.openTextDocument({ language: 'sql', content: ddl });
    await vscode.window.showTextDocument(sqlDoc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    // Not awaited: the notification stays until dismissed and must not block the editor.
    void vscode.window.showInformationMessage(
      `SQL for ${dialect(kind).label}: ${doc.entities.length} tables.`,
      'Save as Flyway Migration…',
    ).then(choice => (choice ? this.saveMigration(doc, ddl) : undefined));
  }

  private async saveMigration(doc: ErdDocument, ddl: string): Promise<void> {
    const project = await scanProject();
    const javaRoot = project.roots[0]?.fsPath;
    const base = javaRoot ? path.resolve(javaRoot, '..', 'resources') : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!base) {
      return;
    }
    const folder = path.join(base, 'db', 'migration');
    let existing: string[] = [];
    try {
      existing = (await vscode.workspace.fs.readDirectory(vscode.Uri.file(folder))).map(([n]) => n);
    } catch {
      // folder does not exist yet
    }
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(folder, nextMigrationName(existing, `create ${doc.name}`))),
      filters: { SQL: ['sql'] },
      saveLabel: 'Save Migration',
    });
    if (target) {
      await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(ddl));
      await vscode.window.showTextDocument(target);
    }
  }

  private async export(document: vscode.TextDocument, format: 'svg' | 'png', data: string): Promise<void> {
    const name = path.basename(document.uri.fsPath).replace(/\.erd\.json$/i, '');
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(path.dirname(document.uri.fsPath), `${name}.${format}`)),
      filters: format === 'svg' ? { 'SVG image': ['svg'] } : { 'PNG image': ['png'] },
      saveLabel: 'Export',
    });
    if (!target) {
      return;
    }
    const bytes = format === 'svg'
      ? new TextEncoder().encode(data)
      : Buffer.from(data.replace(/^data:image\/png;base64,/, ''), 'base64');
    await vscode.workspace.fs.writeFile(target, bytes);
    void vscode.window.showInformationMessage(`Exported ${path.basename(target.fsPath)}.`, 'Open').then(open => {
      if (open) {
        return vscode.commands.executeCommand('vscode.open', target);
      }
    });
  }

  /** Reloads the diagram from its source (entities or database), keeping positions and colors. */
  private async sync(document: vscode.TextDocument, post: (m: { type: string; [k: string]: unknown }) => Thenable<boolean>): Promise<void> {
    const current = parseDocument(document.getText());
    let next: ErdDocument;
    if (current.source?.type === 'database') {
      const src = current.source;
      const config = this.store.get(src.connectionId);
      if (!config) {
        throw new Error(`The connection "${src.connection}" no longer exists.`);
      }
      const tables = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Reading ${src.connection}` },
        async () => (await this.sessions.get(config)).loadTables(src.schema));
      const keep = new Set(current.entities.map(e => e.table.toLowerCase()));
      next = fromTables(tables.filter(t => keep.has(t.name.toLowerCase()) || current.entities.length === 0), config.kind, current.name, src);
    } else {
      await this.jpql.index.whenReady();
      next = fromEntityModel(this.jpql.index.model, current.name, current.dialect);
    }
    const merged = mergeLayout(next, current);
    const text = serializeDocument(merged);
    if (text === document.getText()) {
      post({ type: 'status', message: 'Already up to date.' });
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text);
    await vscode.workspace.applyEdit(edit);
    post({ type: 'status', message: `Synced ${merged.entities.length} tables.` });
  }
}

/** Writes a diagram into the workspace's `erd/` folder (keeping the layout of an existing file) and opens it. */
export async function openDiagram(doc: ErdDocument, fileName: string): Promise<vscode.Uri | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  let uri: vscode.Uri | undefined = folder ? vscode.Uri.joinPath(folder.uri, 'erd', fileName) : undefined;
  if (!uri) {
    uri = await vscode.window.showSaveDialog({ filters: { 'ER diagram': ['erd.json'] }, saveLabel: 'Create Diagram' });
    if (!uri) {
      return undefined;
    }
  }
  let previous: ErdDocument | undefined;
  try {
    previous = parseDocument(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
  } catch {
    // new file
  }
  const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri!.toString());
  const text = serializeDocument(mergeLayout(doc, previous));
  if (open) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(0, 0, open.lineCount, 0), text);
    await vscode.workspace.applyEdit(edit);
    await open.save();
  } else {
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
  }
  await vscode.commands.executeCommand('vscode.openWith', uri, ErdEditorProvider.viewType);
  return uri;
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'diagram';
}
