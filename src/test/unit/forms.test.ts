import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { toGeneratorOptions, UiOptions, validateOptions } from '../../codegen/uiOptions';
import { downloadArtifact } from '../../db/jdbc/runtime';
import { ConnectionDraft, defaultConnectionName, draftToConfig, validateDraft } from '../../model/connectionDraft';

const draft = (d: Partial<ConnectionDraft> = {}): ConnectionDraft => ({
  kind: 'postgresql', name: '', host: 'localhost', port: 5432, database: 'shop', user: 'app', ssl: false, savePassword: true,
  jdbcUrl: '', driverJars: [], driverClass: '', ...d,
});

suite('connection form', () => {
  test('validates server connections', () => {
    assert.deepStrictEqual(validateDraft(draft()), {});
    assert.deepStrictEqual(Object.keys(validateDraft(draft({ host: '', port: 0, database: '', user: '' }))).sort(), ['database', 'host', 'port', 'user']);
    assert.deepStrictEqual(validateDraft(draft({ kind: 'mysql', database: '' })), {}, 'MySQL database is optional');
    assert.deepStrictEqual(validateDraft(draft({ kind: 'sqlserver', host: 'h\\SQLEXPRESS', port: 0, database: '' })), {}, 'named instances need no port');
    assert.match(validateDraft(draft({ kind: 'oracle', database: '' })).database, /Service name is required/);
  });

  test('validates file and URL connections', () => {
    assert.deepStrictEqual(Object.keys(validateDraft(draft({ kind: 'sqlite', database: '' }))), ['database']);
    assert.deepStrictEqual(validateDraft(draft({ kind: 'h2', jdbcUrl: 'jdbc:h2:mem:x', user: '' })), {});
    assert.ok(validateDraft(draft({ kind: 'h2', jdbcUrl: 'h2:mem' })).jdbcUrl);
    assert.ok(validateDraft(draft({ kind: 'jdbc', jdbcUrl: 'jdbc:x:y' })).driverJars, 'generic JDBC needs a jar');
  });

  test('derives default names', () => {
    assert.strictEqual(defaultConnectionName(draft()), 'shop@localhost');
    assert.strictEqual(defaultConnectionName(draft({ database: '' })), 'localhost');
    assert.strictEqual(defaultConnectionName(draft({ kind: 'sqlite', database: '/data/app.db' })), 'app.db');
    assert.strictEqual(defaultConnectionName(draft({ kind: 'h2', jdbcUrl: 'jdbc:h2:tcp://localhost/~/test' })), 'H2 test');
  });

  test('converts drafts to configs, dropping fields that do not apply', () => {
    const c = draftToConfig('id1', draft({ name: '  ', host: ' h ', ssl: true }));
    assert.deepStrictEqual(c, { id: 'id1', name: 'shop@h', kind: 'postgresql', host: 'h', port: 5432, database: 'shop', user: 'app', ssl: true, savePassword: true });
    const s = draftToConfig('id2', draft({ kind: 'sqlite', database: '/a.db', ssl: true, driverJars: ['x.jar'] }));
    assert.deepStrictEqual([s.host, s.port, s.ssl, s.driverJars], ['', 0, false, ['x.jar']]);
    const j = draftToConfig('id3', draft({ kind: 'jdbc', jdbcUrl: ' jdbc:x:y ', driverClass: ' a.B ', driverJars: ['d.jar'] }));
    assert.deepStrictEqual([j.jdbcUrl, j.driverClass], ['jdbc:x:y', 'a.B']);
  });
});

suite('generator options', () => {
  const ui = (o: Partial<UiOptions> = {}): UiOptions => ({
    sourceRoot: '/p/src/main/java', entityPackage: 'com.a.entity', repositoryPackage: 'com.a.repository', generateRepositories: true,
    persistenceApi: 'jakarta', lombok: false, relationships: true, inverseRelationships: true, versionColumn: true,
    stripTablePrefixes: 'tbl_, t_', alwaysSchema: false, ...o,
  });

  test('validates required fields and packages', () => {
    assert.deepStrictEqual(validateOptions(ui()), {});
    assert.deepStrictEqual(Object.keys(validateOptions(ui({ sourceRoot: '', entityPackage: '', repositoryPackage: 'bad..pkg' }))).sort(),
      ['entityPackage', 'repositoryPackage', 'sourceRoot']);
    assert.deepStrictEqual(validateOptions(ui({ generateRepositories: false, repositoryPackage: '' })), {});
  });

  test('converts to generator options', () => {
    const g = toGeneratorOptions(ui({ relationships: false }), 'mysql', 'shop');
    assert.deepStrictEqual(g.stripTablePrefixes, ['tbl_', 't_']);
    assert.strictEqual(g.inverseRelationships, false, 'inverse side requires associations');
    assert.strictEqual(g.defaultSchema, 'shop');
    assert.strictEqual(toGeneratorOptions(ui({ alwaysSchema: true }), 'mysql', 'shop').alwaysIncludeSchema, true);
  });
});

suite('driver download', () => {
  const art = { group: 'g.x', artifact: 'drv', version: '1.0' };

  test('verifies the SHA-1 checksum and stores the jar', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jpt-dl-'));
    const jar = Buffer.from('jar-bytes');
    const sha = createHash('sha1').update(jar).digest('hex');
    const urls: string[] = [];
    const file = await downloadArtifact(art, dir, async url => {
      urls.push(url);
      return url.endsWith('.sha1') ? Buffer.from(`${sha}  drv-1.0.jar\n`) : jar;
    });
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'jar-bytes');
    assert.deepStrictEqual(urls.sort(), ['https://repo1.maven.org/maven2/g/x/drv/1.0/drv-1.0.jar', 'https://repo1.maven.org/maven2/g/x/drv/1.0/drv-1.0.jar.sha1']);
    // Cached on the second call
    await downloadArtifact(art, dir, async () => assert.fail('should not download again'));
  });

  test('rejects a corrupted download and leaves nothing behind', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jpt-dl-'));
    await assert.rejects(
      downloadArtifact(art, dir, async url => (url.endsWith('.sha1') ? Buffer.from('0000') : Buffer.from('tampered'))),
      /Checksum mismatch/,
    );
    assert.deepStrictEqual(fs.readdirSync(dir), []);
  });
});
