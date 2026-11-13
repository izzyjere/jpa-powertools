import * as vscode from 'vscode';
import { ConnectionStore } from './connections/ConnectionStore';
import { JdbcEnvironment } from './connections/JdbcEnvironment';
import { SessionManager } from './connections/SessionManager';
import { buildJdbcUrl } from './db/jdbcUrl';
import { ErdEditorProvider, openDiagram, slug } from './erd/ErdEditorProvider';
import { emptyDocument, fromEntityModel, fromTables } from './erd/erdModel';
import { JpqlService } from './jpql/JpqlService';
import { ConnectionConfig, DbKind } from './model/types';
import { findSpringDatasources } from './project/projectScanner';
import { ConnectionNode, DatabaseExplorer, ExplorerNode, SchemaNode, TableNode } from './views/DatabaseExplorer';
import { ConnectionPanel } from './webview/ConnectionPanel';
import { connectionSource, GeneratorPanel } from './webview/GeneratorPanel';

/** Public API returned from `activate`, used by the integration tests. */
export interface JpaPowerToolsApi {
  store: ConnectionStore;
  sessions: SessionManager;
  explorer: DatabaseExplorer;
  view: vscode.TreeView<ExplorerNode>;
  jpql: JpqlService;
}

export function activate(context: vscode.ExtensionContext): JpaPowerToolsApi {
  const store = new ConnectionStore(context);
  const jdbc = new JdbcEnvironment(context);
  const sessions = new SessionManager(store, jdbc);
  const explorer = new DatabaseExplorer(store, sessions);
  const jpql = new JpqlService();
  const view = vscode.window.createTreeView('jpaPowertools.explorer', {
    treeDataProvider: explorer,
    canSelectMany: true,
    showCollapseAll: true,
  });

  const updateContext = () => vscode.commands.executeCommand('setContext', 'jpaPowertools.hasConnections', store.list().length > 0);
  updateContext();

  const revealConnection = async (config: ConnectionConfig) => {
    explorer.refresh(config.id);
    // Let the tree render the (new) root before revealing it.
    await new Promise(r => setTimeout(r, 50));
    await explorer.getChildren();
    const node = explorer.connectionNode(config.id);
    if (node) {
      await view.reveal(node, { select: true, focus: true, expand: true }).then(undefined, () => undefined);
    }
  };

  const resolveConfig = (arg: unknown): ConnectionConfig | undefined => {
    if (typeof arg === 'string') {
      return store.get(arg);
    }
    if (arg && typeof arg === 'object' && 'config' in arg) {
      return (arg as { config: ConnectionConfig }).config;
    }
    return undefined;
  };

  const pickConnection = async (): Promise<ConnectionConfig | undefined> => {
    const all = store.list();
    if (all.length === 0) {
      const add = await vscode.window.showInformationMessage('No database connections yet.', 'Add Connection');
      if (add) {
        await vscode.commands.executeCommand('jpaPowertools.addConnection');
      }
      return undefined;
    }
    if (all.length === 1) {
      return all[0];
    }
    const pick = await vscode.window.showQuickPick(all.map(c => ({ label: c.name, description: buildJdbcUrl(c), config: c })), {
      placeHolder: 'Choose a connection',
    });
    return pick?.config;
  };

  const showError = (err: unknown) => {
    if ((err as Error)?.message === 'Cancelled') {
      return;
    }
    vscode.window.showErrorMessage((err as Error).message ?? String(err));
  };

  context.subscriptions.push(
    view, store, explorer, sessions, jpql,
    store.onDidChange(updateContext),

    vscode.commands.registerCommand('jpaPowertools.addConnection', () => {
      ConnectionPanel.show(context.extensionUri, store, sessions, undefined, undefined, revealConnection);
    }),

    vscode.commands.registerCommand('jpaPowertools.editConnection', (arg?: unknown) => {
      const config = resolveConfig(arg ?? view.selection[0]);
      if (config) {
        ConnectionPanel.show(context.extensionUri, store, sessions, config, undefined, revealConnection);
      }
    }),

    vscode.commands.registerCommand('jpaPowertools.deleteConnection', async (arg?: unknown) => {
      const config = resolveConfig(arg ?? view.selection[0]);
      if (!config) {
        return;
      }
      const ok = await vscode.window.showWarningMessage(
        `Delete connection "${config.name}"?`,
        { modal: true, detail: 'The saved password is removed as well. Generated code is not affected.' },
        'Delete',
      );
      if (ok === 'Delete') {
        await sessions.disconnect(config.id);
        await store.remove(config.id);
      }
    }),

    vscode.commands.registerCommand('jpaPowertools.refresh', (arg?: unknown) => {
      const config = resolveConfig(arg);
      explorer.refresh(config?.id);
    }),

    vscode.commands.registerCommand('jpaPowertools.disconnect', async (arg?: unknown) => {
      const config = resolveConfig(arg ?? view.selection[0]);
      if (config) {
        await sessions.disconnect(config.id);
        explorer.refresh(config.id);
      }
    }),

    vscode.commands.registerCommand('jpaPowertools.copyJdbcUrl', async (arg?: unknown) => {
      const config = resolveConfig(arg ?? view.selection[0]);
      if (config) {
        await vscode.env.clipboard.writeText(buildJdbcUrl(config));
        vscode.window.setStatusBarMessage('JDBC URL copied to clipboard', 2500);
      }
    }),

    vscode.commands.registerCommand('jpaPowertools.importSpringDatasource', async () => {
      const found = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Looking for Spring datasources' },
        () => findSpringDatasources(),
      );
      if (found.length === 0) {
        const add = await vscode.window.showInformationMessage(
          'No spring.datasource.url found in application*.properties or application*.yml files of this workspace.',
          'Add Connection Manually',
        );
        if (add) {
          await vscode.commands.executeCommand('jpaPowertools.addConnection');
        }
        return;
      }
      const pick = found.length === 1 ? { ds: found[0] } : await vscode.window.showQuickPick(
        found.map(ds => ({ label: ds.url, description: ds.profile ? `profile: ${ds.profile}` : undefined, detail: ds.file, ds })),
        { placeHolder: 'Choose the datasource to import' },
      );
      if (!pick) {
        return;
      }
      const ds = pick.ds;
      ConnectionPanel.show(context.extensionUri, store, sessions, undefined, {
        kind: ds.kind, host: ds.host, port: ds.port, database: ds.database, ssl: ds.ssl, user: ds.user ?? '',
        jdbcUrl: ds.jdbcUrl ?? '', password: ds.password, savePassword: true,
      }, revealConnection);
    }),

    vscode.commands.registerCommand('jpaPowertools.generateEntities', async (node?: ExplorerNode, nodes?: ExplorerNode[]) => {
      try {
        const target = await schemaTarget(node, nodes);
        if (target) {
          GeneratorPanel.show(context, connectionSource(sessions, target.config, target.schema), target.tables);
        }
      } catch (err) {
        showError(err);
      }
    }),

    vscode.window.registerCustomEditorProvider(ErdEditorProvider.viewType, new ErdEditorProvider(context, jpql, store, sessions), {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.commands.registerCommand('jpaPowertools.erdFromEntities', async () => {
      try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Reading JPA entities' }, () => jpql.index.whenReady());
        const model = jpql.index.model;
        if (!model.entities().length) {
          const choice = await vscode.window.showInformationMessage(
            'No @Entity classes were found in this workspace.',
            'Diagram a Database Instead', 'New Empty Diagram',
          );
          if (choice === 'New Empty Diagram') {
            await vscode.commands.executeCommand('jpaPowertools.newErd');
          } else if (choice) {
            await vscode.commands.executeCommand('jpaPowertools.erdFromDatabase');
          }
          return;
        }
        // Use the Spring datasource's database for types and DDL, when there is one.
        const found = (await findSpringDatasources().catch(() => []))[0]?.kind;
        const kind: DbKind = found && found !== 'jdbc' ? found : 'postgresql';
        const name = `${vscode.workspace.name ?? 'Workspace'} entities`;
        await openDiagram(fromEntityModel(model, name, kind), 'entities.erd.json');
      } catch (err) {
        showError(err);
      }
    }),

    vscode.commands.registerCommand('jpaPowertools.erdFromDatabase', async (node?: ExplorerNode, nodes?: ExplorerNode[]) => {
      try {
        const target = await schemaTarget(node, nodes);
        if (!target) {
          return;
        }
        const { config, schema } = target;
        const tables = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Reading ${config.name}${schema ? ` · ${schema}` : ''}` },
          async () => (await sessions.get(config)).loadTables(schema, target.tables.length ? target.tables : undefined),
        );
        if (!tables.length) {
          vscode.window.showInformationMessage(`${schema || config.name} has no tables to diagram.`);
          return;
        }
        const name = schema ? `${config.name} · ${schema}` : config.name;
        const doc = fromTables(tables, config.kind, name, { type: 'database', connectionId: config.id, connection: config.name, schema });
        await openDiagram(doc, `${slug(config.name)}${schema ? `-${slug(schema)}` : ''}.erd.json`);
      } catch (err) {
        showError(err);
      }
    }),

    vscode.commands.registerCommand('jpaPowertools.newErd', async () => {
      let name = 'diagram';
      const folder = vscode.workspace.workspaceFolders?.[0];
      for (let i = 2; folder; i++) {
        try {
          await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, 'erd', `${name}.erd.json`));
          name = `diagram-${i}`;
        } catch {
          break;
        }
      }
      await openDiagram(emptyDocument('New diagram'), `${name}.erd.json`);
    }),
  );

  /** Connection, schema and (optionally) tables from tree nodes, or asked for when run from the Command Palette. */
  async function schemaTarget(node?: ExplorerNode, nodes?: ExplorerNode[]): Promise<{ config: ConnectionConfig; schema: string; tables: string[] } | undefined> {
    const selection = (nodes && nodes.length ? nodes : node ? [node] : [...view.selection]);
    const tables = selection.filter((n): n is TableNode => n.type === 'table');
    if (tables.length) {
      const first = tables[0];
      const sameSchema = tables.filter(t => t.config.id === first.config.id && t.table.schema === first.table.schema);
      return { config: first.config, schema: first.table.schema, tables: sameSchema.map(t => t.table.name) };
    }
    const target = selection[0];
    if (target?.type === 'schema') {
      return { config: (target as SchemaNode).config, schema: (target as SchemaNode).schema, tables: [] };
    }
    const config = target?.type === 'connection' ? (target as ConnectionNode).config : await pickConnection();
    if (!config) {
      return undefined;
    }
    const schemas = await explorer.schemas(config);
    const schema = schemas.length <= 1 ? schemas[0] ?? '' : await vscode.window.showQuickPick(schemas, { placeHolder: `Choose a schema in ${config.name}` });
    return schema === undefined ? undefined : { config, schema, tables: [] };
  }

  return { store, sessions, explorer, view, jpql };
}

export function deactivate(): void {
  // Sessions are disposed through context.subscriptions.
}
