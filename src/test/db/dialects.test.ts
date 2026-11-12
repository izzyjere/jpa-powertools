/**
 * End-to-end checks against real databases (see test-db/ and README "Testing").
 * Each dialect is skipped when its server is not reachable.
 *
 * With `JPT_TEST_LIBS` pointing at the jars from `node scripts/fetch-test-libs.js`, generated code is also
 * compiled with javac and validated by Hibernate 6 (`hbm2ddl.auto=validate`) against the live schema.
 */
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { generateEntities, GeneratorOptions } from '../../codegen/entityGenerator';
import { openSession } from '../../db/connect';
import { findJava, JdbcRuntime } from '../../db/jdbc/runtime';
import { DbSession } from '../../db/session';
import { ConnectionConfig, TableInfo } from '../../model/types';

const ROOT = path.resolve(__dirname, '../../..');
const LIBS = process.env.JPT_TEST_LIBS ? path.resolve(process.env.JPT_TEST_LIBS) : path.join(ROOT, 'test-db', 'lib');
const HAVE_LIBS = fs.existsSync(path.join(LIBS, 'hibernate-core-6.5.3.Final.jar'));

interface Case {
  label: string;
  config: ConnectionConfig;
  password: string;
  schema: string;
  /** Case-fold helper for identifiers (Oracle and Db2 store unquoted names in upper case). */
  n: (s: string) => string;
  comments: boolean;
  /** JDBC URL for the Hibernate validation step; omitted when Hibernate has no dialect for it. */
  hibernateUrl?: string;
  jdbcJars?: string[];
}

const upper = (s: string) => s.toUpperCase();
const same = (s: string) => s;
const cfg = (c: Partial<ConnectionConfig>): ConnectionConfig => ({
  id: c.kind!, name: c.kind!, host: 'localhost', port: 0, database: '', user: '', ssl: false, savePassword: true, ...c,
} as ConnectionConfig);

const CASES: Case[] = [
  {
    label: 'PostgreSQL', password: 'secret', schema: 'public', n: same, comments: true,
    config: cfg({ kind: 'postgresql', port: 55432, database: 'shop', user: 'postgres' }),
    hibernateUrl: 'jdbc:postgresql://localhost:55432/shop',
  },
  {
    label: 'MySQL', password: 'secret', schema: 'shop', n: same, comments: true,
    config: cfg({ kind: 'mysql', port: 53306, database: 'shop', user: 'root' }),
    hibernateUrl: 'jdbc:mysql://localhost:53306/shop?allowPublicKeyRetrieval=true&useSSL=false',
  },
  {
    label: 'MariaDB', password: 'secret', schema: 'shop', n: same, comments: true,
    config: cfg({ kind: 'mariadb', port: 53307, database: 'shop', user: 'root' }),
    hibernateUrl: 'jdbc:mariadb://localhost:53307/shop',
  },
  {
    label: 'SQL Server', password: 'Secret#2026', schema: 'dbo', n: same, comments: true,
    config: cfg({ kind: 'sqlserver', port: 51433, database: 'shop', user: 'sa' }),
    hibernateUrl: 'jdbc:sqlserver://localhost:51433;databaseName=shop;encrypt=false',
  },
  {
    label: 'Oracle', password: 'secret', schema: 'SHOP', n: upper, comments: true,
    config: cfg({ kind: 'oracle', port: 51521, database: 'FREEPDB1', user: 'shop' }),
    hibernateUrl: 'jdbc:oracle:thin:@//localhost:51521/FREEPDB1',
  },
  {
    label: 'Db2 (JDBC bridge)', password: 'secret', schema: 'DB2INST1', n: upper, comments: true,
    config: cfg({ kind: 'db2', port: 55000, database: 'SHOP', user: 'db2inst1' }),
    hibernateUrl: 'jdbc:db2://localhost:55000/SHOP',
    jdbcJars: ['jcc-11.5.9.0.jar'],
  },
  {
    label: 'SQLite (JDBC bridge)', password: '', schema: '', n: same, comments: false,
    config: cfg({ kind: 'sqlite', database: path.join(ROOT, 'test-db', 'shop.sqlite') }),
    jdbcJars: ['sqlite-jdbc-3.46.1.3.jar', 'slf4j-api-1.7.36.jar'],
  },
];

function reachable(port: number): Promise<boolean> {
  if (!port) {
    return Promise.resolve(true);
  }
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}

function options(kind: ConnectionConfig['kind'], defaultSchema: string): GeneratorOptions {
  return {
    kind, entityPackage: 'com.acme.shop.entity', repositoryPackage: 'com.acme.shop.repository', generateRepositories: true,
    persistenceApi: 'jakarta', lombok: false, relationships: true, inverseRelationships: true, stripTablePrefixes: [],
    defaultSchema, versionColumn: true,
  };
}

for (const c of CASES) {
  suite(`Database: ${c.label}`, function () {
    let session: DbSession;
    let tables: TableInfo[];
    const t = (name: string) => tables.find(x => x.name === c.n(name))!;

    suiteSetup(async function () {
      if (!(await reachable(c.config.port))) {
        this.skip();
      }
      let runtime: JdbcRuntime | undefined;
      if (c.jdbcJars) {
        if (!c.jdbcJars.every(j => fs.existsSync(path.join(LIBS, j)))) {
          this.skip();
        }
        runtime = {
          javaPath: await findJava(),
          classpath: c.jdbcJars.map(j => path.join(LIBS, j)),
          bridgeSource: path.join(ROOT, 'resources', 'jdbc', 'JdbcBridge.java'),
        };
      }
      session = openSession(c.config, c.password, runtime);
      await session.serverVersion();
      tables = await session.loadTables(c.schema);
    });

    suiteTeardown(async () => {
      await session?.close();
    });

    test('lists the schema and its tables', async () => {
      const schemas = await session.listSchemas();
      assert.ok(schemas.includes(c.schema), `schemas ${JSON.stringify(schemas)} include "${c.schema}"`);
      const summaries = await session.listTables(c.schema);
      const names = summaries.map(s => s.name);
      for (const name of ['categories', 'customers', 'products', 'orders', 'order_items', 'audit_log', 'order_summary']) {
        assert.ok(names.includes(c.n(name)), `${name} listed in ${JSON.stringify(names)}`);
      }
      assert.strictEqual(summaries.find(s => s.name === c.n('order_summary'))!.kind, 'view');
    });

    test('reads keys, identity columns and comments', () => {
      const customers = t('customers');
      assert.deepStrictEqual(customers.primaryKey, [c.n('id')]);
      const id = customers.columns.find(col => col.name === c.n('id'))!;
      assert.strictEqual(id.autoIncrement, true, 'id is an identity column');
      assert.strictEqual(id.nullable, false);
      assert.ok(customers.uniqueKeys.some(k => k.columns.length === 1 && k.columns[0] === c.n('email')), 'email is unique');
      if (c.comments) {
        assert.strictEqual(customers.comment, 'People who buy things');
        assert.strictEqual(customers.columns.find(col => col.name === c.n('email'))!.comment, 'Login e-mail, unique');
      }

      const orders = t('orders');
      const toCustomers = orders.foreignKeys.filter(fk => fk.referencedTable === c.n('customers'));
      assert.strictEqual(toCustomers.length, 2, 'orders has two FKs to customers');
      assert.deepStrictEqual(toCustomers.map(fk => fk.columns[0]).sort(), [c.n('customer_id'), c.n('shipped_to_id')].sort());

      assert.deepStrictEqual(t('order_items').primaryKey, [c.n('order_id'), c.n('line_no')]);
      assert.deepStrictEqual(t('audit_log').primaryKey, []);
      const self = t('categories').foreignKeys[0];
      assert.strictEqual(self.referencedTable, c.n('categories'));
    });

    test('generates mappings that compile and pass Hibernate schema validation', function () {
      const result = generateEntities(tables, options(c.config.kind, session.defaultSchema(c.schema)));
      const file = (name: string) => result.files.find(f => f.className === name)!.content;

      const customer = file('Customer');
      assert.match(customer, /@GeneratedValue\(strategy = GenerationType\.IDENTITY\)/);
      assert.match(customer, /@Version/);
      assert.match(customer, /unique = true/);
      assert.match(file('OrderItem'), /@IdClass\(OrderItemId\.class\)/);
      assert.match(file('Order'), /private Customer shippedTo;/);
      assert.match(file('Category'), /private Category parent;/);
      assert.match(file('OrderItemRepository'), /JpaRepository<OrderItem, OrderItemId>/);

      if (!HAVE_LIBS) {
        return;
      }
      this.timeout(300_000);
      const work = fs.mkdtempSync(path.join(os.tmpdir(), `jpt-${c.config.kind}-`));
      const src = path.join(work, 'src');
      const classes = path.join(work, 'classes');
      for (const f of result.files) {
        const target = path.join(src, f.relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, f.content);
      }
      const cp = path.join(LIBS, '*');
      const java = process.platform === 'win32' ? 'javac.exe' : 'javac';
      try {
        execFileSync(java, ['-proc:none', '-nowarn', '-d', classes, '-cp', cp, ...result.files.map(f => path.join(src, f.relativePath))],
          { stdio: 'pipe', timeout: 120_000 });
      } catch (e) {
        assert.fail(`javac failed:\n${(e as { stderr?: Buffer }).stderr?.toString() ?? e}`);
      }

      // The Lombok flavour must compile too (Lombok runs as an annotation processor).
      const lombok = generateEntities(tables, { ...options(c.config.kind, session.defaultSchema(c.schema)), lombok: true });
      const lombokSrc = path.join(work, 'lombok-src');
      for (const f of lombok.files) {
        const target = path.join(lombokSrc, f.relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, f.content);
      }
      try {
        execFileSync(java, ['-nowarn', '-processorpath', path.join(LIBS, 'lombok-1.18.34.jar'), '-d', path.join(work, 'lombok-classes'),
          '-cp', cp, ...lombok.files.map(f => path.join(lombokSrc, f.relativePath))], { stdio: 'pipe', timeout: 120_000 });
      } catch (e) {
        assert.fail(`javac (Lombok) failed:
${(e as { stderr?: Buffer }).stderr?.toString() ?? e}`);
      }

      if (!c.hibernateUrl) {
        return;
      }
      try {
        const out = execFileSync('java', [
          '-cp', `${cp}${path.delimiter}${classes}`, path.join(ROOT, 'test-db', 'HibernateValidate.java'),
          c.hibernateUrl, c.config.user, c.password, classes, 'com.acme.shop.entity',
        ], { stdio: 'pipe', timeout: 240_000 }).toString();
        assert.match(out, /VALID \d+ entities/);
      } catch (e) {
        const err = e as { stdout?: Buffer; stderr?: Buffer };
        const text = `${err.stdout ?? ''}${err.stderr ?? ''}`;
        const cause = text.split(/\r?\n/).filter(l => /SchemaManagementException|Exception:|Caused by/.test(l)).slice(0, 6).join('\n');
        assert.fail(`Hibernate validation failed:\n${cause || text.slice(-3000)}`);
      }
    });
  });
}
