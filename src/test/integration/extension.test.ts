import * as assert from 'assert';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { JpaPowerToolsApi } from '../../extension';
import { ConnectionConfig } from '../../model/types';
import { findSpringDatasources, scanProject } from '../../project/projectScanner';
import { ConnectionNode, ExplorerNode, SchemaNode, TableNode } from '../../views/DatabaseExplorer';
import { GeneratorPanel, UiOptions } from '../../webview/GeneratorPanel';
import { screenshot } from './screenshot';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) {
      return v;
    }
    await sleep(100);
  }
  throw new Error('Timed out waiting for condition');
}

function reachable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}

const PG: ConnectionConfig = {
  id: 'it-pg', name: 'Shop (Postgres)', kind: 'postgresql', host: 'localhost',
  port: Number(process.env.JPT_PG_PORT ?? 55432), database: 'shop', user: 'postgres', ssl: false, savePassword: true,
};

suite('JPA Power Tools in VS Code', () => {
  let api: JpaPowerToolsApi;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension<JpaPowerToolsApi>('izzyjere.jpa-powertools');
    assert.ok(ext, 'extension is installed in the test instance');
    api = await ext.activate();
    for (const c of api.store.list()) {
      await api.store.remove(c.id);
    }
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('contributes its commands', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const id of ['addConnection', 'editConnection', 'deleteConnection', 'refresh', 'disconnect', 'copyJdbcUrl', 'importSpringDatasource', 'generateEntities']) {
      assert.ok(all.includes(`jpaPowertools.${id}`), `jpaPowertools.${id} is registered`);
    }
  });

  test('shows the welcome view when there are no connections', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.jpaPowertools');
    await sleep(1500);
    screenshot('01-welcome');
    assert.deepStrictEqual(await api.explorer.getChildren(), []);
  });

  test('detects the Spring Boot project and its datasource', async () => {
    const project = await scanProject();
    assert.strictEqual(project.roots.length, 1);
    assert.strictEqual(project.roots[0].basePackage, 'com.acme.shop');
    assert.strictEqual(project.roots[0].entityPackage, 'com.acme.shop.domain', 'prefers the existing domain package');
    assert.strictEqual(project.persistenceApi, 'jakarta');
    assert.strictEqual(project.lombok, true);
    assert.strictEqual(project.springDataJpa, true);

    const ds = await findSpringDatasources();
    assert.strictEqual(ds.length, 1);
    assert.strictEqual(ds[0].kind, 'postgresql');
    assert.strictEqual(ds[0].port, 55432);
    assert.strictEqual(ds[0].user, 'postgres');
    assert.strictEqual(ds[0].password, 'secret');
  });

  test('opens the connection form', async () => {
    await vscode.commands.executeCommand('jpaPowertools.addConnection');
    const tab = await waitFor(() => vscode.window.tabGroups.all.flatMap(g => g.tabs).find(t => t.label === 'New Connection'));
    assert.ok(tab);
    await sleep(2500);
    screenshot('02-connection-form');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  suite('with a live PostgreSQL database', function () {
    suiteSetup(async function () {
      if (!(await reachable(PG.port))) {
        this.skip();
      }
      await api.store.save(PG, 'secret');
    });

    test('browses connection → schemas → tables → columns', async () => {
      const [conn] = await api.explorer.getChildren() as ConnectionNode[];
      assert.strictEqual(conn.config.name, PG.name);

      const schemas = await api.explorer.getChildren(conn) as SchemaNode[];
      assert.deepStrictEqual(schemas.map(s => s.schema), ['public', 'sales']);

      const tables = await api.explorer.getChildren(schemas[0]) as TableNode[];
      const names = tables.map(t => t.table.name);
      for (const t of ['customers', 'orders', 'order_items', 'order_summary', 'user']) {
        assert.ok(names.includes(t), `lists ${t}`);
      }
      assert.strictEqual(tables.find(t => t.table.name === 'order_summary')!.table.kind, 'view');

      const customers = tables.find(t => t.table.name === 'customers')!;
      const columns = await api.explorer.getChildren(customers) as ExplorerNode[];
      const id = columns.find(c => c.type === 'column' && c.column.name === 'id');
      assert.ok(id);
      const item = api.explorer.getTreeItem(id!);
      assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, 'key');

      await api.view.reveal(conn, { expand: true, select: false });
      await api.view.reveal(schemas[0], { expand: true, select: false });
      await api.view.reveal(customers, { expand: true, select: true, focus: true });
      await sleep(1500);
      screenshot('03-explorer');
    });

    test('reports a friendly error for a wrong password', async () => {
      const bad: ConnectionConfig = { ...PG, id: 'it-bad', name: 'Wrong password' };
      await api.store.save(bad, 'nope');
      try {
        const roots = await api.explorer.getChildren() as ConnectionNode[];
        const node = roots.find(r => r.config.id === bad.id)!;
        const [msg] = await api.explorer.getChildren(node);
        assert.strictEqual(msg.type, 'message');
        assert.match(api.explorer.getTreeItem(msg).label as string, /Authentication failed for user "postgres"/);
      } finally {
        await api.store.remove(bad.id);
      }
    });

    test('generates entities and repositories through the wizard', async () => {
      const [conn] = await api.explorer.getChildren() as ConnectionNode[];
      const [publicSchema] = await api.explorer.getChildren(conn) as SchemaNode[];
      await vscode.commands.executeCommand('jpaPowertools.generateEntities', publicSchema);
      const panel = await waitFor(() => GeneratorPanel.panels()[0]);
      const init = await waitFor(() => panel.lastPosted.get('init') as { options: UiOptions; tables: Array<{ name: string }> } | undefined, 30_000);
      assert.strictEqual(init.options.entityPackage, 'com.acme.shop.domain');
      assert.strictEqual(init.options.lombok, true);
      assert.ok(init.tables.length >= 8);
      await sleep(2500);
      screenshot('04-generator');

      const out = fs.mkdtempSync(path.join(os.tmpdir(), 'jpt-gen-'));
      const options: UiOptions = { ...init.options, sourceRoot: out, lombok: false, inverseRelationships: true };
      const tables = ['customers', 'orders', 'order_items', 'products', 'categories', 'customer_profiles'];

      await panel.handle({ type: 'preview', tables, focus: 'orders', options, seq: 1 });
      const preview = panel.lastPosted.get('preview') as { files: Array<{ path: string }>; focusFiles: Array<{ content: string }> };
      assert.ok(preview.focusFiles[0].content.includes('public class Order {'));

      await panel.handle({ type: 'generate', tables, options });
      const result = await waitFor(() => panel.lastPosted.get('generated') as { written: string[] } | undefined);
      assert.strictEqual(result.written.length, preview.files.length);

      const order = fs.readFileSync(path.join(out, 'com/acme/shop/domain/Order.java'), 'utf8');
      assert.match(order, /@ManyToOne\(fetch = FetchType\.LAZY, optional = false\)\s+@JoinColumn\(name = "customer_id", nullable = false\)\s+private Customer customer;/);
      assert.match(order, /@OneToMany\(mappedBy = "order"\)/);
      const repo = fs.readFileSync(path.join(out, 'com/acme/shop/repository/OrderItemRepository.java'), 'utf8');
      assert.match(repo, /extends JpaRepository<OrderItem, OrderItemId>/);
      assert.ok(fs.existsSync(path.join(out, 'com/acme/shop/domain/OrderItemId.java')));
      await sleep(1500);
      screenshot('05-generated');
    });
  });
});
