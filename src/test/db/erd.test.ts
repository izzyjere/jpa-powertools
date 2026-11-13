/**
 * ER diagram round trips against real databases:
 *   fixture @Entity classes → diagram → DDL, executed in a scratch database, then
 *   (a) Hibernate validates the original entities against those tables,
 *   (b) entities generated back from the diagram compile and pass Hibernate validation too,
 *   (c) introspecting the scratch database yields the same tables and relationships.
 * Each database is skipped when unreachable; Hibernate steps need `npm run test:libs`.
 */
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { generateEntities } from '../../codegen/entityGenerator';
import { openSession } from '../../db/connect';
import { generateDdl, splitStatements } from '../../erd/ddl';
import { ErdDocument, fromEntityModel, fromTables, toTables } from '../../erd/erdModel';
import { EntityModel } from '../../jpql/entityModel';
import { parseJavaClasses } from '../../jpql/javaSource';
import { ConnectionConfig, DbKind } from '../../model/types';

const ROOT = path.resolve(__dirname, '../../..');
const LIBS = process.env.JPT_TEST_LIBS ? path.resolve(process.env.JPT_TEST_LIBS) : path.join(ROOT, 'test-db', 'lib');
const HAVE_LIBS = fs.existsSync(path.join(LIBS, 'hibernate-core-6.5.3.Final.jar'));
const DOMAIN = path.join(ROOT, 'src/test/fixtures/spring-app/src/main/java/com/acme/shop/domain');
const SCRATCH = 'erd_test';

interface Target {
  kind: DbKind;
  port: number;
  /** Recreates the scratch database and runs the statements in it. */
  run(statements: string[]): Promise<void>;
  /** Drops the scratch database. */
  cleanup(): Promise<void>;
  /** Connection used to introspect the scratch database. */
  config: ConnectionConfig;
  password: string;
  schema: string;
  hibernateUrl: string;
  user: string;
}

const cfg = (c: Partial<ConnectionConfig>): ConnectionConfig => ({
  id: 'erd', name: 'erd', host: 'localhost', port: 0, database: '', user: '', ssl: false, savePassword: true, ...c,
} as ConnectionConfig);

const TARGETS: Target[] = [
  {
    kind: 'postgresql', port: 55432, password: 'secret', user: 'postgres', schema: SCRATCH,
    config: cfg({ kind: 'postgresql', port: 55432, database: 'shop', user: 'postgres' }),
    hibernateUrl: `jdbc:postgresql://localhost:55432/shop?currentSchema=${SCRATCH}`,
    async cleanup() {
      const { Client } = require('pg') as typeof import('pg');
      const c = new Client({ host: 'localhost', port: 55432, user: 'postgres', password: 'secret', database: 'shop' });
      await c.connect();
      await c.query(`drop schema if exists ${SCRATCH} cascade`).finally(() => c.end());
    },
    async run(statements) {
      const { Client } = require('pg') as typeof import('pg');
      const c = new Client({ host: 'localhost', port: 55432, user: 'postgres', password: 'secret', database: 'shop' });
      await c.connect();
      try {
        await c.query(`drop schema if exists ${SCRATCH} cascade`);
        await c.query(`create schema ${SCRATCH}`);
        await c.query(`set search_path to ${SCRATCH}`);
        for (const s of statements) {
          await c.query(s);
        }
      } finally {
        await c.end();
      }
    },
  },
  ...(['mysql', 'mariadb'] as const).map((kind): Target => {
    const port = kind === 'mysql' ? 53306 : 53307;
    return {
      kind, port, password: 'secret', user: 'root', schema: SCRATCH,
      config: cfg({ kind, port, database: SCRATCH, user: 'root' }),
      hibernateUrl: `jdbc:${kind}://localhost:${port}/${SCRATCH}${kind === 'mysql' ? '?allowPublicKeyRetrieval=true&useSSL=false' : ''}`,
      async cleanup() {
        const mysql = require('mysql2/promise') as typeof import('mysql2/promise');
        const c = await mysql.createConnection({ host: 'localhost', port, user: 'root', password: 'secret' });
        await c.query(`drop database if exists ${SCRATCH}`).finally(() => c.end());
      },
      async run(statements) {
        const mysql = require('mysql2/promise') as typeof import('mysql2/promise');
        const c = await mysql.createConnection({ host: 'localhost', port, user: 'root', password: 'secret' });
        try {
          await c.query(`drop database if exists ${SCRATCH}`);
          await c.query(`create database ${SCRATCH}`);
          await c.query(`use ${SCRATCH}`);
          for (const s of statements) {
            await c.query(s);
          }
        } finally {
          await c.end();
        }
      },
    };
  }),
  {
    kind: 'sqlserver', port: 51433, password: 'Secret#2026', user: 'sa', schema: 'dbo',
    config: cfg({ kind: 'sqlserver', port: 51433, database: SCRATCH, user: 'sa' }),
    hibernateUrl: `jdbc:sqlserver://localhost:51433;databaseName=${SCRATCH};encrypt=false`,
    async cleanup() {
      const mssql = require('mssql') as typeof import('mssql');
      const admin = await new mssql.ConnectionPool({ server: 'localhost', port: 51433, user: 'sa', password: 'Secret#2026', database: 'master', options: { encrypt: false, trustServerCertificate: true } }).connect();
      await admin.request().batch(`if db_id('${SCRATCH}') is not null begin alter database ${SCRATCH} set single_user with rollback immediate; drop database ${SCRATCH}; end`).finally(() => admin.close());
    },
    async run(statements) {
      const mssql = require('mssql') as typeof import('mssql');
      const base = { server: 'localhost', port: 51433, user: 'sa', password: 'Secret#2026', options: { encrypt: false, trustServerCertificate: true } };
      const admin = await new mssql.ConnectionPool({ ...base, database: 'master' }).connect();
      try {
        await admin.request().batch(`if db_id('${SCRATCH}') is not null begin alter database ${SCRATCH} set single_user with rollback immediate; drop database ${SCRATCH}; end`);
        await admin.request().batch(`create database ${SCRATCH}`);
      } finally {
        await admin.close();
      }
      const pool = await new mssql.ConnectionPool({ ...base, database: SCRATCH }).connect();
      try {
        for (const s of statements) {
          await pool.request().batch(s);
        }
      } finally {
        await pool.close();
      }
    },
  },
  {
    kind: 'oracle', port: 51521, password: 'secret', user: SCRATCH, schema: SCRATCH.toUpperCase(),
    config: cfg({ kind: 'oracle', port: 51521, database: 'FREEPDB1', user: SCRATCH }),
    hibernateUrl: 'jdbc:oracle:thin:@//localhost:51521/FREEPDB1',
    async cleanup() {
      const oracledb = require('oracledb') as typeof import('oracledb');
      const sys = await oracledb.getConnection({ user: 'system', password: 'secret', connectString: 'localhost:51521/FREEPDB1' });
      await sys.execute(`begin execute immediate 'drop user ${SCRATCH} cascade'; exception when others then null; end;`).finally(() => sys.close());
    },
    async run(statements) {
      const oracledb = require('oracledb') as typeof import('oracledb');
      const sys = await oracledb.getConnection({ user: 'system', password: 'secret', connectString: 'localhost:51521/FREEPDB1' });
      try {
        await sys.execute(`begin execute immediate 'drop user ${SCRATCH} cascade'; exception when others then null; end;`);
        await sys.execute(`create user ${SCRATCH} identified by secret quota unlimited on users`);
        await sys.execute(`grant create session, create table, create sequence to ${SCRATCH}`);
      } finally {
        await sys.close();
      }
      const c = await oracledb.getConnection({ user: SCRATCH, password: 'secret', connectString: 'localhost:51521/FREEPDB1' });
      try {
        for (const s of statements) {
          await c.execute(s);
        }
      } finally {
        await c.close();
      }
    },
  },
];

function reachable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}

function loadModel(): EntityModel {
  const files = fs.readdirSync(DOMAIN).map(f => path.join(DOMAIN, f));
  return new EntityModel(files.map(f => ({ file: f, classes: parseJavaClasses(fs.readFileSync(f, 'utf8')) })));
}

function javac(out: string, sources: string[]): void {
  try {
    execFileSync(process.platform === 'win32' ? 'javac.exe' : 'javac', ['-proc:none', '-nowarn', '-d', out, '-cp', path.join(LIBS, '*'), ...sources], { stdio: 'pipe' });
  } catch (e) {
    assert.fail(`javac failed:\n${(e as { stderr?: Buffer }).stderr?.toString()}`);
  }
}

function hibernateValidate(t: Target, classes: string, pkg: string, naming: 'snake' | 'standard' = 'standard'): void {
  try {
    execFileSync('java', ['-cp', `${path.join(LIBS, '*')}${path.delimiter}${classes}`, path.join(ROOT, 'test-db', 'HibernateValidate.java'),
      t.hibernateUrl, t.user, t.password, classes, pkg, naming], { stdio: 'pipe', timeout: 240_000 });
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer };
    const text = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    assert.fail(`Hibernate validation failed:\n${text.split(/\r?\n/).filter(l => /Schema-validation|Exception:/.test(l)).slice(0, 4).join('\n') || text.slice(-2000)}`);
  }
}

for (const t of TARGETS) {
  suite(`ER diagram round trip: ${t.kind}`, function () {
    this.timeout(300_000);
    let doc: ErdDocument;
    let work: string;

    let ran = false;
    suiteTeardown(async () => {
      if (ran) {
        await t.cleanup();
      }
    });

    suiteSetup(async function () {
      if (!(await reachable(t.port))) {
        this.skip();
      }
      doc = fromEntityModel(loadModel(), 'shop', t.kind);
      ran = true;
      await t.run(splitStatements(generateDdl(doc, t.kind)));
      work = fs.mkdtempSync(path.join(os.tmpdir(), `jpt-erd-${t.kind}-`));
    });

    test('the DDL creates the tables the original entities expect', function () {
      if (!HAVE_LIBS) {
        this.skip();
      }
      const classes = path.join(work, 'original');
      javac(classes, fs.readdirSync(DOMAIN).map(f => path.join(DOMAIN, f)));
      // The fixture entities rely on Spring Boot's snake_case naming, like a Spring Boot app would.
      hibernateValidate(t, classes, 'com.acme.shop.domain', 'snake');
    });

    test('entities generated from the diagram compile and match the same tables', function () {
      if (!HAVE_LIBS) {
        this.skip();
      }
      const { tables, classNames } = toTables(doc, t.kind);
      const result = generateEntities(tables, {
        kind: t.kind, entityPackage: 'com.acme.gen', repositoryPackage: 'com.acme.gen', generateRepositories: false,
        persistenceApi: 'jakarta', lombok: false, relationships: true, inverseRelationships: true, stripTablePrefixes: [],
        versionColumn: true, classNames,
      });
      const src = path.join(work, 'gen-src');
      for (const f of result.files) {
        fs.mkdirSync(path.dirname(path.join(src, f.relativePath)), { recursive: true });
        fs.writeFileSync(path.join(src, f.relativePath), f.content);
      }
      assert.ok(result.files.some(f => f.className === 'PurchaseOrder'), 'class names from the diagram are kept');
      const classes = path.join(work, 'gen');
      javac(classes, result.files.map(f => path.join(src, f.relativePath)));
      hibernateValidate(t, classes, 'com.acme.gen');
    });

    test('introspecting the database gives back the same diagram structure', async () => {
      const session = openSession(t.config, t.password);
      try {
        const tables = await session.loadTables(t.schema);
        const back = fromTables(tables, t.kind, 'back');
        const norm = (s: string) => s.toLowerCase();
        assert.deepStrictEqual(back.entities.map(e => norm(e.table)).sort(), doc.entities.map(e => norm(e.table)).sort());
        for (const e of doc.entities) {
          const other = back.entities.find(x => norm(x.table) === norm(e.table))!;
          assert.deepStrictEqual(other.columns.map(c => norm(c.name)), e.columns.map(c => norm(c.name)), e.table);
          assert.deepStrictEqual(other.columns.filter(c => c.primaryKey).map(c => norm(c.name)), e.columns.filter(c => c.primaryKey).map(c => norm(c.name)));
          for (const c of e.columns) {
            const o = other.columns.find(x => norm(x.name) === norm(c.name))!;
            const sameFamily = o.type === c.type || (c.type === 'TIMESTAMPTZ' && t.kind !== 'postgresql' && t.kind !== 'oracle' && t.kind !== 'sqlserver')
              || (c.type === 'SMALLINT' && o.type === 'INTEGER') || (c.type === 'BOOLEAN' && t.kind === 'oracle');
            assert.ok(sameFamily, `${e.table}.${c.name}: ${c.type} came back as ${o.type} (${o.nativeType})`);
          }
        }
        assert.strictEqual(back.relationships.length, doc.relationships.length, 'foreign keys');
      } finally {
        await session.close();
      }
    });
  });
}

suite('ER diagram DDL: sqlite', () => {
  test('the DDL runs on SQLite', function () {
    let sqlite: { DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void } };
    try {
      sqlite = require('node:sqlite');
    } catch {
      this.skip();
    }
    const doc = fromEntityModel(loadModel(), 'shop', 'sqlite');
    const db = new sqlite!.DatabaseSync(':memory:');
    try {
      db.exec(generateDdl(doc, 'sqlite'));
    } finally {
      db.close();
    }
  });
});
