import * as assert from 'assert';
import { hasLength, hasPrecision, mapColumnType, mapOracleNumber } from '../../codegen/typeMapping';
import { DbKind } from '../../model/types';
import { col } from './fixtures';

const java = (kind: DbKind, dataType: string, extra = {}) => mapColumnType(col('c', dataType, extra), kind).javaType;

suite('typeMapping', () => {
  test('PostgreSQL', () => {
    assert.strictEqual(java('postgresql', 'int8'), 'Long');
    assert.strictEqual(java('postgresql', 'int4'), 'Integer');
    assert.strictEqual(java('postgresql', 'numeric'), 'BigDecimal');
    assert.strictEqual(java('postgresql', 'timestamptz'), 'OffsetDateTime');
    assert.strictEqual(java('postgresql', 'timestamp'), 'LocalDateTime');
    assert.strictEqual(java('postgresql', 'uuid'), 'UUID');
    assert.strictEqual(java('postgresql', 'bytea'), 'byte[]');
    assert.strictEqual(java('postgresql', '_text'), 'String[]');
    assert.strictEqual(java('postgresql', '_int4'), 'Integer[]');
    assert.strictEqual(java('postgresql', 'bit', { length: 1 }), 'Boolean');
    assert.ok(mapColumnType(col('c', 'jsonb'), 'postgresql').json);
    assert.strictEqual(mapColumnType(col('c', 'bpchar'), 'postgresql').fixedChar, 'CHAR');
    assert.ok(mapColumnType(col('c', 'my_enum'), 'postgresql').unmapped);
    assert.deepStrictEqual(mapColumnType(col('c', 'timestamptz'), 'postgresql').imports, ['java.time.OffsetDateTime']);
  });

  test('MySQL / MariaDB', () => {
    assert.strictEqual(java('mysql', 'tinyint', { length: 1 }), 'Boolean');
    assert.strictEqual(java('mysql', 'tinyint', { length: 4 }), 'Byte');
    assert.strictEqual(java('mysql', 'int', { unsigned: true }), 'Long');
    assert.strictEqual(mapColumnType(col('c', 'int', { unsigned: true }), 'mysql').columnDefinition, 'int unsigned');
    assert.strictEqual(java('mysql', 'bigint', { unsigned: true }), 'Long');
    assert.strictEqual(mapColumnType(col('c', 'bigint', { unsigned: true }), 'mysql').columnDefinition, undefined);
    assert.strictEqual(java('mariadb', 'datetime'), 'LocalDateTime');
    assert.strictEqual(java('mysql', 'bit', { precision: 1 }), 'Boolean');
    assert.strictEqual(java('mysql', 'bit', { precision: 8 }), 'byte[]');
    const e = mapColumnType(col('c', 'enum', { displayType: "enum('NEW','PAID')" }), 'mysql');
    assert.deepStrictEqual([e.javaType, e.columnDefinition], ['String', "enum('NEW','PAID')"]);
    assert.strictEqual(mapColumnType(col('c', 'longblob'), 'mysql').columnDefinition, 'longblob');
    assert.ok(mapColumnType(col('c', 'geometry'), 'mysql').unmapped);
  });

  test('SQL Server', () => {
    assert.strictEqual(java('sqlserver', 'bit'), 'Boolean');
    assert.strictEqual(java('sqlserver', 'uniqueidentifier'), 'UUID');
    assert.strictEqual(java('sqlserver', 'datetimeoffset'), 'OffsetDateTime');
    assert.strictEqual(java('sqlserver', 'datetime2'), 'LocalDateTime');
    assert.strictEqual(java('sqlserver', 'nvarchar(max)'), 'String');
    assert.strictEqual(java('sqlserver', 'money'), 'BigDecimal');
    assert.strictEqual(mapColumnType(col('c', 'nchar'), 'sqlserver').fixedChar, 'NCHAR');
  });

  test('Oracle NUMBER precision rules', () => {
    assert.strictEqual(mapOracleNumber(1, 0).javaType, 'Boolean');
    assert.strictEqual(mapOracleNumber(5, 0).javaType, 'Integer');
    assert.strictEqual(mapOracleNumber(10, 0).javaType, 'Long');
    assert.strictEqual(mapOracleNumber(19, 0).javaType, 'Long');
    assert.strictEqual(mapOracleNumber(30, 0).javaType, 'BigInteger');
    assert.strictEqual(mapOracleNumber(null, 0).javaType, 'Long');
    assert.strictEqual(mapOracleNumber(10, 2).javaType, 'BigDecimal');
    assert.strictEqual(mapOracleNumber(null, null).javaType, 'BigDecimal');
    assert.strictEqual(java('oracle', 'date'), 'LocalDateTime');
    assert.strictEqual(java('oracle', 'timestamp with time zone'), 'OffsetDateTime');
    assert.strictEqual(java('oracle', 'clob'), 'String');
    assert.ok(mapColumnType(col('c', 'clob'), 'oracle').lob);
    assert.strictEqual(mapColumnType(col('c', 'binary_double'), 'oracle').columnDefinition, 'binary_double');
  });

  test('JDBC dialects use java.sql.Types with type-name hints', () => {
    assert.strictEqual(java('db2', 'integer', { jdbcType: 4 }), 'Integer');
    assert.strictEqual(java('db2', 'timestamp', { jdbcType: 93 }), 'LocalDateTime');
    assert.strictEqual(java('db2', 'boolean', { jdbcType: 16 }), 'Boolean');
    assert.strictEqual(java('h2', 'uuid', { jdbcType: 1111 }), 'UUID');
    assert.strictEqual(java('h2', 'timestamp with time zone', { jdbcType: 2014 }), 'OffsetDateTime');
    // SQLite reports declared TIMESTAMP as VARCHAR
    assert.strictEqual(java('sqlite', 'timestamp', { jdbcType: 12 }), 'LocalDateTime');
    assert.strictEqual(java('sqlite', 'boolean', { jdbcType: 12 }), 'Boolean');
    assert.strictEqual(java('sqlite', 'varchar', { jdbcType: 12 }), 'String');
    assert.strictEqual(java('derby', 'bit', { jdbcType: -7, length: 8 }), 'byte[]');
    assert.ok(mapColumnType(col('c', 'xmltype', { jdbcType: 2002 }), 'jdbc').unmapped);
  });

  test('length and precision attributes', () => {
    assert.strictEqual(hasLength(col('c', 'varchar', { length: 50 }), 'postgresql'), true);
    assert.strictEqual(hasLength(col('c', 'text', { length: 50 }), 'postgresql'), false);
    assert.strictEqual(hasLength(col('c', 'varchar2', { length: 50 }), 'oracle'), true);
    assert.strictEqual(hasLength(col('c', 'x', { length: 50, jdbcType: 12 }), 'db2'), true);
    assert.strictEqual(hasPrecision(col('c', 'numeric', { precision: 10, scale: 2 })), true);
    assert.strictEqual(hasPrecision(col('c', 'numeric')), false);
    assert.strictEqual(hasPrecision(col('c', 'number', { precision: 10, scale: 0 }), 'oracle'), false);
    assert.strictEqual(hasPrecision(col('c', 'number', { precision: 10, scale: 2 }), 'oracle'), true);
  });
});
