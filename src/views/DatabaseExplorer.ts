import * as vscode from 'vscode';
import { ConnectionStore } from '../connections/ConnectionStore';
import { CancelledError, ConnectionError, SessionManager } from '../connections/SessionManager';
import { buildJdbcUrl } from '../db/jdbcUrl';
import { friendlyError } from '../db/session';
import { ColumnInfo, ConnectionConfig, dialect, TableInfo, TableSummary } from '../model/types';

export type ExplorerNode = ConnectionNode | SchemaNode | TableNode | ColumnNode | MessageNode;

export class ConnectionNode {
  readonly type = 'connection';
  constructor(readonly config: ConnectionConfig) {}
}

export class SchemaNode {
  readonly type = 'schema';
  constructor(readonly config: ConnectionConfig, readonly schema: string) {}
}

export class TableNode {
  readonly type = 'table';
  constructor(readonly config: ConnectionConfig, readonly table: TableSummary) {}
}

export class ColumnNode {
  readonly type = 'column';
  constructor(readonly config: ConnectionConfig, readonly table: TableInfo, readonly column: ColumnInfo) {}
}

export class MessageNode {
  readonly type = 'message';
  constructor(
    readonly parentId: string,
    readonly label: string,
    readonly icon: string,
    readonly tooltip?: string,
    readonly command?: vscode.Command,
  ) {}
}

export function describeConnection(c: ConnectionConfig): string {
  const d = dialect(c.kind);
  if (d.target === 'file') {
    return `${d.label} · ${c.database.replace(/^.*[\\/]/, '')}`;
  }
  if (d.target === 'url' || (d.driver === 'jdbc' && c.jdbcUrl)) {
    return `${d.label} · ${(c.jdbcUrl ?? '').replace(/^jdbc:/, '')}`;
  }
  const port = c.host.includes('\\') ? '' : `:${c.port}`;
  return `${d.label} · ${c.host}${port}${c.database && !c.database.startsWith('(') ? `/${c.database}` : ''}`;
}

/** Tree of connections → schemas → tables → columns. Data is loaded lazily and cached until refresh. */
export class DatabaseExplorer implements vscode.TreeDataProvider<ExplorerNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ExplorerNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private readonly schemaCache = new Map<string, Promise<string[]>>();
  private readonly tableCache = new Map<string, Promise<TableSummary[]>>();
  private readonly detailCache = new Map<string, Promise<TableInfo | undefined>>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly roots = new Map<string, ConnectionNode>();
  /** Last schema list per connection, to resolve parents synchronously. */
  private readonly knownSchemas = new Map<string, string[]>();

  constructor(private readonly store: ConnectionStore, private readonly sessions: SessionManager) {
    this.disposables.push(
      store.onDidChange(() => this.emitter.fire()),
      sessions.onDidChangeState(id => {
        const node = this.roots.get(id);
        if (node) {
          this.emitter.fire(node);
        }
      }),
    );
  }

  /** Clears cached metadata (for one connection or all) and re-renders. */
  refresh(connectionId?: string): void {
    for (const cache of [this.schemaCache, this.tableCache, this.detailCache] as Map<string, unknown>[]) {
      for (const key of [...cache.keys()]) {
        if (!connectionId || key.startsWith(connectionId + '|')) {
          cache.delete(key);
        }
      }
    }
    this.emitter.fire(connectionId ? this.roots.get(connectionId) : undefined);
  }

  connectionNode(id: string): ConnectionNode | undefined {
    return this.roots.get(id);
  }

  /** Required by `TreeView.reveal`. */
  getParent(node: ExplorerNode): ExplorerNode | undefined {
    switch (node.type) {
      case 'schema':
        return this.roots.get(node.config.id);
      case 'table':
        return (this.knownSchemas.get(node.config.id)?.length ?? 0) > 1
          ? new SchemaNode(node.config, node.table.schema)
          : this.roots.get(node.config.id);
      case 'column':
        return new TableNode(node.config, { schema: node.table.schema, name: node.table.name, kind: node.table.kind, comment: node.table.comment });
      default:
        return undefined;
    }
  }

  getTreeItem(node: ExplorerNode): vscode.TreeItem {
    switch (node.type) {
      case 'connection': {
        const c = node.config;
        const connected = this.sessions.isConnected(c.id);
        const item = new vscode.TreeItem(c.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `conn:${c.id}`;
        item.description = describeConnection(c);
        item.iconPath = new vscode.ThemeIcon('database', connected ? new vscode.ThemeColor('charts.green') : undefined);
        item.contextValue = connected ? 'connection.connected' : 'connection';
        const tip = new vscode.MarkdownString();
        tip.appendMarkdown(`**${escapeMd(c.name)}**${connected ? ' · connected' : ''}\n\n`);
        tip.appendCodeblock(buildJdbcUrl(c) || describeConnection(c), 'text');
        if (c.user) {
          tip.appendMarkdown(`\nUser: \`${escapeMd(c.user)}\``);
        }
        item.tooltip = tip;
        return item;
      }
      case 'schema': {
        const item = new vscode.TreeItem(node.schema || '(default)', vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `schema:${node.config.id}:${node.schema}`;
        item.iconPath = new vscode.ThemeIcon('symbol-namespace');
        item.contextValue = 'schema';
        return item;
      }
      case 'table': {
        const t = node.table;
        const item = new vscode.TreeItem(t.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `table:${node.config.id}:${t.schema}:${t.name}`;
        item.iconPath = new vscode.ThemeIcon(t.kind === 'view' ? 'eye' : 'table');
        item.description = t.kind === 'view' ? 'view' : undefined;
        item.tooltip = t.comment ? `${t.name}\n\n${t.comment}` : t.name;
        item.contextValue = t.kind === 'view' ? 'table.view' : 'table';
        return item;
      }
      case 'column': {
        const { column: col, table } = node;
        const isPk = table.primaryKey.includes(col.name);
        const fk = table.foreignKeys.find(f => f.columns.includes(col.name));
        const item = new vscode.TreeItem(col.name, vscode.TreeItemCollapsibleState.None);
        item.id = `col:${node.config.id}:${table.schema}:${table.name}:${col.name}`;
        item.description = `${col.displayType}${col.nullable ? '' : ' · not null'}${col.autoIncrement ? ' · auto' : ''}`;
        item.iconPath = new vscode.ThemeIcon(isPk ? 'key' : fk ? 'references' : 'symbol-field',
          isPk ? new vscode.ThemeColor('charts.yellow') : undefined);
        const lines = [`${col.name}: ${col.displayType}`];
        if (isPk) {
          lines.push('Primary key');
        }
        if (fk) {
          lines.push(`References ${fk.referencedTable}(${fk.referencedColumns.join(', ')})`);
        }
        if (col.comment) {
          lines.push('', col.comment);
        }
        item.tooltip = lines.join('\n');
        item.contextValue = 'column';
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.id = `msg:${node.parentId}:${node.label}`;
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.tooltip = node.tooltip ?? node.label;
        item.command = node.command;
        item.contextValue = 'message';
        return item;
      }
    }
  }

  async getChildren(node?: ExplorerNode): Promise<ExplorerNode[]> {
    if (!node) {
      this.roots.clear();
      return this.store.list().map(c => {
        const n = new ConnectionNode(c);
        this.roots.set(c.id, n);
        return n;
      });
    }
    try {
      switch (node.type) {
        case 'connection': {
          const schemas = await this.schemas(node.config);
          this.knownSchemas.set(node.config.id, schemas);
          if (schemas.length === 1) {
            return this.tableNodes(node.config, schemas[0]);
          }
          if (schemas.length === 0) {
            return [new MessageNode(node.config.id, 'No schemas visible to this user', 'info')];
          }
          return schemas.map(s => new SchemaNode(node.config, s));
        }
        case 'schema':
          return this.tableNodes(node.config, node.schema);
        case 'table': {
          const info = await this.tableDetail(node.config, node.table);
          if (!info) {
            return [new MessageNode(`${node.config.id}:${node.table.name}`, 'Table no longer exists. Refresh the connection.', 'warning')];
          }
          return info.columns.map(c => new ColumnNode(node.config, info, c));
        }
        default:
          return [];
      }
    } catch (err) {
      return [this.errorNode(node, err)];
    }
  }

  private errorNode(node: ExplorerNode, err: unknown): MessageNode {
    const config = (node as ConnectionNode).config;
    const parentId = `${config.id}:${node.type}`;
    const retry: vscode.Command = { command: 'jpaPowertools.refresh', title: 'Retry', arguments: [this.roots.get(config.id) ?? node] };
    if (err instanceof CancelledError) {
      return new MessageNode(parentId, 'Not connected. Click to connect', 'debug-disconnect', undefined, retry);
    }
    const message = err instanceof ConnectionError ? err.message : friendlyError(err, config);
    return new MessageNode(parentId, `Couldn't connect: ${message}`, 'error', `${message}\n\nClick to retry.`, retry);
  }

  private async tableNodes(config: ConnectionConfig, schema: string): Promise<ExplorerNode[]> {
    const tables = await this.tables(config, schema);
    if (tables.length === 0) {
      return [new MessageNode(`${config.id}:${schema}`, 'No tables or views', 'info')];
    }
    return tables.map(t => new TableNode(config, t));
  }

  async schemas(config: ConnectionConfig): Promise<string[]> {
    const key = `${config.id}|schemas`;
    let p = this.schemaCache.get(key);
    if (!p) {
      p = Promise.resolve(vscode.window.withProgress({ location: { viewId: 'jpaPowertools.explorer' } }, async () => {
        const session = await this.sessions.get(config);
        return session.listSchemas();
      }));
      this.schemaCache.set(key, p);
      p.catch(() => this.schemaCache.delete(key));
    }
    return p;
  }

  async tables(config: ConnectionConfig, schema: string): Promise<TableSummary[]> {
    const key = `${config.id}|${schema}`;
    let p = this.tableCache.get(key);
    if (!p) {
      p = Promise.resolve(vscode.window.withProgress({ location: { viewId: 'jpaPowertools.explorer' } }, async () => {
        const session = await this.sessions.get(config);
        return session.listTables(schema);
      }));
      this.tableCache.set(key, p);
      p.catch(() => this.tableCache.delete(key));
    }
    return p;
  }

  private tableDetail(config: ConnectionConfig, table: TableSummary): Promise<TableInfo | undefined> {
    const key = `${config.id}|${table.schema}|${table.name}`;
    let p = this.detailCache.get(key);
    if (!p) {
      p = Promise.resolve(vscode.window.withProgress({ location: { viewId: 'jpaPowertools.explorer' } }, async () => {
        const session = await this.sessions.get(config);
        const [info] = await session.loadTables(table.schema, [table.name]);
        return info;
      }));
      this.detailCache.set(key, p);
      p.catch(() => this.detailCache.delete(key));
    }
    return p;
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this.emitter.dispose();
  }
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
