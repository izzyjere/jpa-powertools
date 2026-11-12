import * as assert from 'assert';
import { filterSchemas, mapJdbcColumn, mapJdbcTableSummary } from '../../db/jdbc/jdbcSession';
import { mavenJarUrl, parseJavaMajor } from '../../db/jdbc/runtime';
import { assembleMysqlTables, mapMysqlColumn } from '../../db/mysql';
import { mapOracleColumn, oracleConnectString } from '../../db/oracle';
import { assemblePgTables, mapPgColumn } from '../../db/postgres';
import { friendlyError } from '../../db/session';
import { mapMssqlColumn, splitInstance } from '../../db/sqlserver';
import { assembleTables } from '../../model/types';
import { col } from './fixtures';

suite('introspection row mapping', () => {
  test('PostgreSQL columns and constraints', () => {
    const c = mapPgColumn({
      column_name: 'id', data_type: 'bigint', udt_name: 'int8', character_maximum_length: null, numeric_precision: 64,
      numeric_scale: 0, is_nullable: 'NO', column_default: "nextval('t_id_seq'::regclass)", is_identity: 'NO', display_type: 'bigint', comment: null,
    });
    assert.deepStrictEqual([c.dataType, c.nullable, c.autoIncrement], ['int8', false, true]);
    assert.strictEqual(mapPgColumn({ column_name: 'tags', data_type: 'ARRAY', udt_name: '_text', is_nullable: 'YES' }).dataType, '_text');

    const [t] = assemblePgTables('public',
      [{ name: 'orders', relkind: 'r', comment: 'Orders' }],
      [{ table_name: 'orders', column_name: 'id', udt_name: 'int8', is_nullable: 'NO', is_identity: 'YES' },
        { table_name: 'orders', column_name: 'customer_id', udt_name: 'int8', is_nullable: 'NO' }],
      [{ name: 'orders_pkey', type: 'p', table_name: 'orders', columns: ['id'], ref_columns: [] },
        { name: 'fk_c', type: 'f', table_name: 'orders', ref_schema: 'public', ref_table: 'customers', columns: '{customer_id}', ref_columns: '{id}' },
        { name: 'uk_dup', type: 'u', table_name: 'orders', columns: ['id'], ref_columns: [] }]);
    assert.deepStrictEqual(t.primaryKey, ['id']);
    assert.deepStrictEqual(t.foreignKeys, [{ name: 'fk_c', columns: ['customer_id'], referencedSchema: 'public', referencedTable: 'customers', referencedColumns: ['id'] }]);
    assert.deepStrictEqual(t.uniqueKeys, [], 'a unique key equal to the PK is dropped');
    assert.strictEqual(t.comment, 'Orders');
  });

  test('MySQL columns and grouped constraints', () => {
    const b = mapMysqlColumn({ name: 'active', data_type: 'tinyint', column_type: 'tinyint(1)', len: null, nullable: 'NO', extra: '' });
    assert.deepStrictEqual([b.length, b.unsigned], [1, false]);
    const u = mapMysqlColumn({ name: 'id', data_type: 'bigint', column_type: 'bigint unsigned', nullable: 'NO', extra: 'auto_increment' });
    assert.deepStrictEqual([u.unsigned, u.autoIncrement], [true, true]);
    assert.strictEqual(mapMysqlColumn({ name: 's', data_type: 'enum', column_type: "enum('New','Paid')", nullable: 'YES' }).displayType, "enum('New','Paid')");
    assert.strictEqual(mapMysqlColumn({ name: 'x', data_type: Buffer.from('varchar'), column_type: 'varchar(5)', len: '5', nullable: 'YES' }).length, 5);

    const [t] = assembleMysqlTables('shop',
      [{ name: 'order_items', type: 'BASE TABLE', comment: '' }],
      [{ tbl: 'order_items', name: 'order_id', data_type: 'bigint', column_type: 'bigint', nullable: 'NO' }],
      [{ type: 'PRIMARY KEY', name: 'PRIMARY', tbl: 'order_items', col: 'order_id' },
        { type: 'PRIMARY KEY', name: 'PRIMARY', tbl: 'order_items', col: 'line_no' },
        { type: 'FOREIGN KEY', name: 'fk', tbl: 'order_items', col: 'a', ref_schema: 'shop', ref_table: 'x', ref_col: 'a' },
        { type: 'FOREIGN KEY', name: 'fk', tbl: 'order_items', col: 'b', ref_schema: 'shop', ref_table: 'x', ref_col: 'b' }]);
    assert.deepStrictEqual(t.primaryKey, ['order_id', 'line_no']);
    assert.deepStrictEqual(t.foreignKeys[0].columns, ['a', 'b']);
    assert.strictEqual(t.comment, null);
  });

  test('SQL Server columns', () => {
    const n = mapMssqlColumn({ column_name: 'name', data_type: 'nvarchar', user_type: 'nvarchar', max_length: 200, is_nullable: false, is_identity: false });
    assert.deepStrictEqual([n.length, n.displayType], [100, 'nvarchar(100)']);
    const max = mapMssqlColumn({ column_name: 'notes', data_type: 'nvarchar', user_type: 'nvarchar', max_length: -1, is_nullable: true });
    assert.deepStrictEqual([max.dataType, max.length, max.displayType], ['nvarchar(max)', null, 'nvarchar(max)']);
    const d = mapMssqlColumn({ column_name: 'p', data_type: 'decimal', user_type: 'decimal', max_length: 9, precision: 10, scale: 2, is_nullable: true });
    assert.deepStrictEqual([d.precision, d.scale, d.displayType], [10, 2, 'decimal(10,2)']);
    assert.deepStrictEqual(splitInstance('srv\\SQLEXPRESS'), { server: 'srv', instanceName: 'SQLEXPRESS' });
    assert.deepStrictEqual(splitInstance('srv'), { server: 'srv' });
  });

  test('Oracle columns and connect strings', () => {
    const ts = mapOracleColumn({ column_name: 'AT', data_type: 'TIMESTAMP(6) WITH TIME ZONE', nullable: 'N' });
    assert.deepStrictEqual([ts.dataType, ts.nullable], ['timestamp with time zone', false]);
    const v = mapOracleColumn({ column_name: 'NAME', data_type: 'VARCHAR2', char_length: 100, nullable: 'Y', identity: 'NO' });
    assert.deepStrictEqual([v.length, v.displayType], [100, 'VARCHAR2(100)']);
    const n = mapOracleColumn({ column_name: 'ID', data_type: 'NUMBER', precision: 10, scale: 0, nullable: 'N', identity: 'YES' });
    assert.deepStrictEqual([n.autoIncrement, n.displayType], [true, 'NUMBER(10)']);
    assert.strictEqual(oracleConnectString({ host: 'h', port: 1521, database: 'FREEPDB1', ssl: false }), 'h:1521/FREEPDB1?connect_timeout=10');
    assert.strictEqual(oracleConnectString({ host: 'h', port: 2484, database: 'svc', ssl: true }), 'tcps://h:2484/svc?connect_timeout=10');
    assert.strictEqual(oracleConnectString({ host: 'h', port: 1, database: '(DESCRIPTION=x)', ssl: false }), '(DESCRIPTION=x)');
  });

  test('JDBC metadata rows', () => {
    assert.strictEqual(mapJdbcTableSummary('S', { name: 'T', type: 'SYSTEM TABLE' }), undefined);
    assert.strictEqual(mapJdbcTableSummary('S', { name: 'V', type: 'VIEW' })!.kind, 'view');
    const c = mapJdbcColumn({ name: 'NAME', jdbcType: 12, typeName: 'VARCHAR', size: 100, nullable: true, autoIncrement: false });
    assert.deepStrictEqual([c.length, c.displayType, c.dataType], [100, 'VARCHAR(100)', 'varchar']);
    assert.strictEqual(mapJdbcColumn({ name: 'T', jdbcType: 12, typeName: 'TEXT', size: 2000000000, nullable: true }).length, null);
    const d = mapJdbcColumn({ name: 'P', jdbcType: 3, typeName: 'DECIMAL', size: 10, digits: 2, nullable: false });
    assert.deepStrictEqual([d.precision, d.scale, d.displayType], [10, 2, 'DECIMAL(10,2)']);
    assert.ok(mapJdbcColumn({ name: 'ID', jdbcType: 4, typeName: 'INTEGER', default: 'GENERATED BY DEFAULT AS IDENTITY' }).autoIncrement);
  });

  test('hides system schemas and puts the current one first', () => {
    assert.deepStrictEqual(filterSchemas(['SYSIBM', 'SYSCAT', 'NULLID', 'APP', 'DB2INST1'], 'DB2INST1'), ['DB2INST1', 'APP']);
    assert.deepStrictEqual(filterSchemas(['INFORMATION_SCHEMA', 'PUBLIC'], 'PUBLIC'), ['PUBLIC']);
    assert.deepStrictEqual(filterSchemas(['SYS'], null), ['SYS'], 'never ends up empty');
    assert.deepStrictEqual(filterSchemas([''], null), ['']);
  });

  test('assembleTables marks primary key columns NOT NULL', () => {
    const [t] = assembleTables([{ schema: '', name: 't', kind: 'table', comment: null }],
      [{ table: 't', column: col('id', 'integer', { nullable: true }) }],
      [{ table: 't', type: 'p', name: 'pk', column: 'id' }]);
    assert.strictEqual(t.columns[0].nullable, false);
  });
});

suite('errors and runtime helpers', () => {
  const where = { host: 'db', port: 5432, database: 'shop', user: 'app' };

  test('turns driver errors into actionable messages', () => {
    assert.match(friendlyError({ code: 'ECONNREFUSED', message: 'x' }, where), /Connection refused at db:5432/);
    assert.match(friendlyError({ code: '28P01', message: 'x' }, where), /Authentication failed for user "app"/);
    assert.match(friendlyError({ code: 'ELOGIN', message: "Login failed for user 'app'." }, where), /Authentication failed/);
    assert.match(friendlyError(new Error('ORA-01017: invalid username/password; logon denied'), where), /Authentication failed/);
    assert.match(friendlyError(new Error('ORA-12514: listener does not currently know of service'), where), /does not know service "shop"/);
    assert.match(friendlyError({ code: '3D000', message: 'x' }, where), /Database "shop" does not exist/);
    assert.match(friendlyError({ code: 'ENOTFOUND', message: 'x' }, where), /could not be resolved/);
    assert.match(friendlyError(new Error('The server does not support SSL connections'), where), /Turn off "Use SSL"/);
    assert.strictEqual(friendlyError(new Error('something odd'), where), 'something odd');
  });

  test('parses Java versions', () => {
    assert.strictEqual(parseJavaMajor('openjdk version "21.0.2" 2024-01-16'), 21);
    assert.strictEqual(parseJavaMajor('java version "1.8.0_392"'), 8);
    assert.strictEqual(parseJavaMajor('openjdk version "11" 2018-09-25'), 11);
    assert.strictEqual(parseJavaMajor('garbage'), undefined);
  });

  test('builds Maven Central URLs', () => {
    assert.strictEqual(mavenJarUrl({ group: 'com.ibm.db2', artifact: 'jcc', version: '11.5.9.0' }),
      'https://repo1.maven.org/maven2/com/ibm/db2/jcc/11.5.9.0/jcc-11.5.9.0.jar');
  });
});
