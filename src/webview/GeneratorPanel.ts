import * as path from 'path';
import * as vscode from 'vscode';
import { SessionManager } from '../connections/SessionManager';
import { GeneratedFile, generateEntities } from '../codegen/entityGenerator';
import { toGeneratorOptions, UiOptions, validateOptions } from '../codegen/uiOptions';
import { friendlyError } from '../db/session';
import { ConnectionConfig, DbKind, TableInfo } from '../model/types';

export type { UiOptions };
import { describeSourceRoot, ProjectInfo, scanProject, SourceRoot } from '../project/projectScanner';
import { webviewHtml } from './html';

export type FromWebview =
  | { type: 'ready' }
  | { type: 'preview'; tables: string[]; focus: string | null; options: UiOptions; seq: number }
  | { type: 'generate'; tables: string[]; options: UiOptions }
  | { type: 'browseRoot' }
  | { type: 'openFile'; path: string }
  | { type: 'retry' };

const OPTIONS_KEY = 'jpaPowertools.generatorOptions';

/** Where the generator gets its tables from: a live database connection or an ER diagram. */
export interface TableSource {
  /** Identifies the panel (one panel per source). */
  key: string;
  /** Shown in the panel header, e.g. the connection or diagram name. */
  label: string;
  schema: string;
  kind: DbKind;
  load(): Promise<TableInfo[]>;
  /** Schema that does not need to be written into @Table. */
  defaultSchema(): Promise<string>;
  /** Class name overrides by `schema.table` (diagrams keep the names chosen there). */
  classNames?: Record<string, string>;
  describeError(err: unknown): string;
}

/** Tables of one schema of a database connection. */
export function connectionSource(sessions: SessionManager, config: ConnectionConfig, schema: string): TableSource {
  return {
    key: `${config.id}|${schema}`,
    label: config.name,
    schema,
    kind: config.kind,
    load: () => sessions.get(config).then(s => s.loadTables(schema)),
    defaultSchema: () => sessions.get(config).then(s => s.defaultSchema(schema)),
    describeError: err => friendlyError(err, config),
  };
}

/** Wizard for generating entities and repositories from a schema's tables. One panel per connection + schema. */
export class GeneratorPanel {
  private static readonly open = new Map<string, GeneratorPanel>();

  /** Open panels; exposed for integration tests. */
  static panels(): GeneratorPanel[] {
    return [...GeneratorPanel.open.values()];
  }

  /** Last message posted to the webview, by type; exposed for integration tests. */
  readonly lastPosted = new Map<string, unknown>();
  private readonly panel: vscode.WebviewPanel;
  private metadata: Promise<TableInfo[]> | undefined;
  private project: ProjectInfo | undefined;

  static show(context: vscode.ExtensionContext, source: TableSource, preselected: string[]): void {
    const key = source.key;
    const existing = GeneratorPanel.open.get(key);
    if (existing) {
      existing.panel.reveal();
      if (preselected.length) {
        existing.post({ type: 'select', tables: preselected });
      }
      return;
    }
    GeneratorPanel.open.set(key, new GeneratorPanel(context, source, preselected, key));
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly source: TableSource,
    private readonly preselected: string[],
    key: string,
  ) {
    const title = source.schema ? `Generate Entities · ${source.schema}` : `Generate Entities · ${source.label}`;
    this.panel = vscode.window.createWebviewPanel('jpaPowertools.generator', title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'database.svg');
    this.panel.webview.html = webviewHtml(this.panel.webview, context.extensionUri, title, 'generator.js');
    this.panel.webview.onDidReceiveMessage((m: FromWebview) => this.handle(m).catch(err => {
      this.post({ type: 'error', message: (err as Error).message });
    }));
    this.panel.onDidDispose(() => GeneratorPanel.open.delete(key));
  }

  private post(msg: { type: string; [key: string]: unknown }) {
    this.lastPosted.set(msg.type, msg);
    return this.panel.webview.postMessage(msg);
  }

  private loadMetadata(): Promise<TableInfo[]> {
    if (!this.metadata) {
      this.metadata = this.source.load();
      this.metadata.catch(() => (this.metadata = undefined));
    }
    return this.metadata;
  }

  /** Handles a message from the webview (public so tests can drive the panel). */
  async handle(m: FromWebview): Promise<void> {
    switch (m.type) {
      case 'ready':
      case 'retry':
        await this.init();
        return;
      case 'preview':
        await this.preview(m.tables, m.focus, m.options, m.seq);
        return;
      case 'generate':
        await this.generate(m.tables, m.options);
        return;
      case 'browseRoot': {
        const uris = await vscode.window.showOpenDialog({
          canSelectFolders: true, canSelectFiles: false, openLabel: 'Use as Source Folder',
          defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
        });
        if (uris?.[0]) {
          const root = await describeSourceRoot(uris[0]);
          this.post({ type: 'rootAdded', root });
        }
        return;
      }
      case 'openFile':
        await vscode.window.showTextDocument(vscode.Uri.file(m.path), { preview: false });
        return;
    }
  }

  private async init(): Promise<void> {
    let tables: TableInfo[];
    try {
      [tables, this.project] = await Promise.all([this.loadMetadata(), this.project ? Promise.resolve(this.project) : scanProject()]);
    } catch (err) {
      this.post({ type: 'loadError', message: this.source.describeError(err) });
      return;
    }
    const defaultSchema = await this.source.defaultSchema();
    const project = this.project;
    const saved = this.context.workspaceState.get<Partial<UiOptions>>(OPTIONS_KEY);
    const root: SourceRoot | undefined = project.roots.find(r => r.fsPath === saved?.sourceRoot) ?? project.roots[0];
    const defaults: UiOptions = {
      sourceRoot: root?.fsPath ?? '',
      entityPackage: root?.entityPackage ?? 'com.example.entity',
      repositoryPackage: root?.repositoryPackage ?? 'com.example.repository',
      generateRepositories: project.roots.length ? project.springDataJpa : true,
      persistenceApi: project.persistenceApi,
      lombok: project.lombok,
      relationships: true,
      inverseRelationships: false,
      versionColumn: true,
      stripTablePrefixes: '',
      alwaysSchema: false,
    };
    const options: UiOptions = { ...defaults, ...saved, sourceRoot: defaults.sourceRoot };
    if (saved?.sourceRoot && !project.roots.some(r => r.fsPath === saved.sourceRoot)) {
      // A custom folder chosen earlier: keep it if it still exists.
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(saved.sourceRoot));
        const custom = await describeSourceRoot(vscode.Uri.file(saved.sourceRoot));
        project.roots.push(custom);
        options.sourceRoot = custom.fsPath;
      } catch {
        // Folder is gone; fall back to the detected root.
      }
    }

    // FK graph so the UI can offer to add referenced tables.
    const references: Record<string, string[]> = {};
    for (const t of tables) {
      references[t.name] = [...new Set(t.foreignKeys
        .filter(fk => fk.referencedSchema === t.schema && fk.referencedTable !== t.name)
        .map(fk => fk.referencedTable))];
    }

    this.post({
      type: 'init',
      connection: this.source.label,
      schema: this.source.schema,
      defaultSchema,
      tables: tables.map(t => ({
        name: t.name,
        kind: t.kind,
        comment: t.comment,
        columns: t.columns.length,
        hasPk: t.primaryKey.length > 0,
      })),
      references,
      preselected: this.preselected.filter(p => tables.some(t => t.name === p)),
      roots: project.roots,
      detected: {
        persistenceApi: project.persistenceApiDetected ? project.persistenceApi : null,
        lombok: project.lombok,
        springDataJpa: project.springDataJpa,
      },
      options,
    });
  }

  private async build(tableNames: string[], ui: UiOptions): Promise<{ files: GeneratedFile[]; warnings: string[] }> {
    const all = await this.loadMetadata();
    const wanted = new Set(tableNames);
    const tables = all.filter(t => wanted.has(t.name));
    const options = toGeneratorOptions(ui, this.source.kind, await this.source.defaultSchema());
    return generateEntities(tables, { ...options, classNames: this.source.classNames });
  }

  private async existing(root: string, files: GeneratedFile[]): Promise<Set<string>> {
    const out = new Set<string>();
    if (!root) {
      return out;
    }
    await Promise.all(files.map(async f => {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(path.join(root, f.relativePath)));
        out.add(f.relativePath);
      } catch {
        // does not exist
      }
    }));
    return out;
  }

  private async preview(tables: string[], focus: string | null, ui: UiOptions, seq: number): Promise<void> {
    const names = focus && !tables.includes(focus) ? [...tables, focus] : tables;
    const { files, warnings } = await this.build(names, ui);
    const selectedFiles = files.filter(f => tables.includes(f.tableName));
    const exists = await this.existing(ui.sourceRoot, selectedFiles);
    const focusFiles = focus ? files.filter(f => f.tableName === focus) : [];
    this.post({
      type: 'preview',
      seq,
      errors: validateOptions(ui),
      files: selectedFiles.map(f => ({ path: f.relativePath, className: f.className, kind: f.kind, table: f.tableName, exists: exists.has(f.relativePath) })),
      focus,
      focusFiles: focusFiles.map(f => ({ path: f.relativePath, className: f.className, kind: f.kind, content: f.content })),
      warnings,
    });
  }

  private async generate(tables: string[], ui: UiOptions): Promise<void> {
    const errors = validateOptions(ui);
    if (Object.keys(errors).length) {
      this.post({ type: 'validation', errors });
      return;
    }
    if (tables.length === 0) {
      this.post({ type: 'error', message: 'Select at least one table.' });
      return;
    }
    const { files } = await this.build(tables, ui);
    const exists = await this.existing(ui.sourceRoot, files);
    let skipExisting = false;
    if (exists.size) {
      const sample = [...exists].slice(0, 5).map(p => `• ${p}`).join('\n') + (exists.size > 5 ? `\n… and ${exists.size - 5} more` : '');
      const choice = await vscode.window.showWarningMessage(
        `${exists.size} of ${files.length} files already exist.`,
        { modal: true, detail: `${sample}\n\nOverwrite them with the generated code, or keep your versions and only create the new files?` },
        'Overwrite', 'Skip Existing',
      );
      if (!choice) {
        this.post({ type: 'generated', cancelled: true });
        return;
      }
      skipExisting = choice === 'Skip Existing';
    }

    const written: string[] = [];
    let overwritten = 0;
    let skipped = 0;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Generating JPA entities' }, async progress => {
      const encoder = new TextEncoder();
      for (const f of files) {
        const isExisting = exists.has(f.relativePath);
        if (isExisting && skipExisting) {
          skipped++;
          continue;
        }
        progress.report({ message: f.className, increment: 100 / files.length });
        const target = vscode.Uri.file(path.join(ui.sourceRoot, f.relativePath));
        await vscode.workspace.fs.writeFile(target, encoder.encode(f.content));
        written.push(target.fsPath);
        if (isExisting) {
          overwritten++;
        }
      }
    });

    await this.context.workspaceState.update(OPTIONS_KEY, ui);
    this.post({ type: 'generated', written, overwritten, skipped, root: ui.sourceRoot });

    const created = written.length - overwritten;
    const parts = [`${created} created`];
    if (overwritten) {
      parts.push(`${overwritten} overwritten`);
    }
    if (skipped) {
      parts.push(`${skipped} skipped`);
    }
    const firstEntity = files.find(f => f.kind === 'entity' && written.some(w => w.endsWith(path.normalize(f.relativePath))));
    // Not awaited: the notification stays until dismissed and must not block the panel.
    const openLabel = firstEntity ? `Open ${firstEntity.className}.java` : undefined;
    void vscode.window.showInformationMessage(
      `Generated ${written.length} file${written.length === 1 ? '' : 's'} (${parts.join(', ')}).`,
      ...(openLabel ? [openLabel] : []),
    ).then(action => {
      if (action && firstEntity) {
        return vscode.window.showTextDocument(vscode.Uri.file(path.join(ui.sourceRoot, firstEntity.relativePath)));
      }
    });
  }
}
