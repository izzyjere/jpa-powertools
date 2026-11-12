import * as assert from 'assert';
import { buildJdbcUrl, parseJdbcUrl } from '../../db/jdbcUrl';

suite('jdbcUrl', () => {
  test('parses PostgreSQL URLs', () => {
    assert.deepStrictEqual(parseJdbcUrl('jdbc:postgresql://db.local:5433/shop?sslmode=require'), {
      kind: 'postgresql', host: 'db.local', port: 5433, database: 'shop', ssl: true, user: undefined, password: undefined,
    });
    const p = parseJdbcUrl('jdbc:postgresql://localhost/shop?user=app&password=s3cret')!;
    assert.strictEqual(p.port, 5432);
    assert.strictEqual(p.user, 'app');
    assert.strictEqual(p.password, 's3cret');
    assert.strictEqual(parseJdbcUrl('jdbc:postgresql:shop')!.database, 'shop');
    assert.strictEqual(parseJdbcUrl('jdbc:postgresql://h:1/d?sslmode=disable')!.ssl, false);
  });

  test('parses driver-style URLs with credentials', () => {
    const p = parseJdbcUrl('postgres://user:p%40ss@pg.example.com:6543/app')!;
    assert.deepStrictEqual([p.kind, p.host, p.port, p.database, p.user, p.password], ['postgresql', 'pg.example.com', 6543, 'app', 'user', 'p@ss']);
  });

  test('parses MySQL / MariaDB URLs', () => {
    const m = parseJdbcUrl('jdbc:mysql://127.0.0.1:3307/shop?useSSL=true&serverTimezone=UTC')!;
    assert.deepStrictEqual([m.kind, m.host, m.port, m.database, m.ssl], ['mysql', '127.0.0.1', 3307, 'shop', true]);
    assert.strictEqual(parseJdbcUrl('jdbc:mysql:loadbalance://h1:3306,h2:3306/db')!.host, 'h1');
    assert.strictEqual(parseJdbcUrl('jdbc:mariadb://[::1]:3306/db')!.host, '::1');
    assert.strictEqual(parseJdbcUrl('jdbc:mysql://h/')!.database, '');
  });

  test('parses SQL Server URLs', () => {
    const s = parseJdbcUrl('jdbc:sqlserver://sql.local:1444;databaseName=shop;encrypt=true;user=sa;password=x')!;
    assert.deepStrictEqual([s.kind, s.host, s.port, s.database, s.ssl, s.user, s.password], ['sqlserver', 'sql.local', 1444, 'shop', true, 'sa', 'x']);
    const named = parseJdbcUrl('jdbc:sqlserver://host\\SQLEXPRESS;database=db')!;
    assert.strictEqual(named.host, 'host\\SQLEXPRESS');
    assert.strictEqual(named.database, 'db');
    assert.strictEqual(named.ssl, false);
  });

  test('parses Oracle URLs', () => {
    const svc = parseJdbcUrl('jdbc:oracle:thin:@//ora.local:1522/FREEPDB1')!;
    assert.deepStrictEqual([svc.kind, svc.host, svc.port, svc.database], ['oracle', 'ora.local', 1522, 'FREEPDB1']);
    assert.strictEqual(parseJdbcUrl('jdbc:oracle:thin:@ora:1521:XE')!.database, 'XE');
    const cred = parseJdbcUrl('jdbc:oracle:thin:scott/tiger@ora:1521/ORCL')!;
    assert.deepStrictEqual([cred.user, cred.password, cred.database], ['scott', 'tiger', 'ORCL']);
    assert.strictEqual(parseJdbcUrl('jdbc:oracle:thin:@tcps://ora:2484/svc')!.ssl, true);
    const desc = parseJdbcUrl('jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=h1)(PORT=1530))(CONNECT_DATA=(SERVICE_NAME=s)))')!;
    assert.strictEqual(desc.host, 'h1');
    assert.strictEqual(desc.port, 1530);
    assert.ok(desc.database.startsWith('(DESCRIPTION'));
  });

  test('parses Db2, Derby and Firebird URLs', () => {
    const d = parseJdbcUrl('jdbc:db2://db2.local:50001/SAMPLE:sslConnection=true;')!;
    assert.deepStrictEqual([d.kind, d.host, d.port, d.database, d.ssl], ['db2', 'db2.local', 50001, 'SAMPLE', true]);
    const derby = parseJdbcUrl('jdbc:derby://localhost:1527/app;create=true')!;
    assert.deepStrictEqual([derby.kind, derby.database], ['derby', 'app']);
    assert.strictEqual(parseJdbcUrl('jdbc:firebirdsql://fb:3050/employee')!.kind, 'firebird');
  });

  test('keeps URL-only databases as raw JDBC URLs', () => {
    const h2 = parseJdbcUrl('jdbc:h2:tcp://localhost/~/test')!;
    assert.deepStrictEqual([h2.kind, h2.jdbcUrl], ['h2', 'jdbc:h2:tcp://localhost/~/test']);
    const sqlite = parseJdbcUrl('jdbc:sqlite:C:\\data\\app.db')!;
    assert.deepStrictEqual([sqlite.kind, sqlite.database], ['sqlite', 'C:\\data\\app.db']);
    const other = parseJdbcUrl('jdbc:informix-sqli://h:9088/db:INFORMIXSERVER=x')!;
    assert.deepStrictEqual([other.kind, other.jdbcUrl], ['jdbc', 'jdbc:informix-sqli://h:9088/db:INFORMIXSERVER=x']);
  });

  test('rejects non-URLs', () => {
    assert.strictEqual(parseJdbcUrl('hello'), undefined);
    assert.strictEqual(parseJdbcUrl('jdbc:postgresql://host:abc/db'), undefined);
    assert.strictEqual(parseJdbcUrl(''), undefined);
  });

  test('builds URLs that parse back to the same settings', () => {
    const configs = [
      { kind: 'postgresql', host: 'h', port: 5432, database: 'd', ssl: true },
      { kind: 'mysql', host: 'h', port: 3306, database: 'd', ssl: false },
      { kind: 'sqlserver', host: 'h', port: 1433, database: 'd', ssl: true },
      { kind: 'oracle', host: 'h', port: 1521, database: 'FREEPDB1', ssl: false },
      { kind: 'db2', host: 'h', port: 50000, database: 'D', ssl: false },
    ] as const;
    for (const c of configs) {
      const parsed = parseJdbcUrl(buildJdbcUrl(c))!;
      assert.deepStrictEqual([parsed.kind, parsed.host, parsed.port, parsed.database, parsed.ssl], [c.kind, c.host, c.port, c.database, c.ssl], c.kind);
    }
    assert.strictEqual(buildJdbcUrl({ kind: 'sqlserver', host: 'h\\SQLEXPRESS', port: 1433, database: '', ssl: false }), 'jdbc:sqlserver://h\\SQLEXPRESS;encrypt=false');
    assert.strictEqual(buildJdbcUrl({ kind: 'sqlite', host: '', port: 0, database: '/tmp/a.db', ssl: false }), 'jdbc:sqlite:/tmp/a.db');
    assert.strictEqual(buildJdbcUrl({ kind: 'h2', host: '', port: 0, database: '', ssl: false, jdbcUrl: 'jdbc:h2:mem:x' }), 'jdbc:h2:mem:x');
  });
});
