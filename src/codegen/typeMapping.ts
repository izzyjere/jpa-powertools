import { ColumnInfo, DbKind } from '../model/types';

export interface JavaTypeMapping {
  /** Simple Java type name, e.g. `Long`, `byte[]`, `LocalDateTime`. */
  javaType: string;
  /** Fully qualified imports required by `javaType` (java.lang types need none). */
  imports: string[];
  /** Emit `@Lob` on the field. */
  lob?: boolean;
  /** Emit `@JdbcTypeCode(SqlTypes.JSON)` (Hibernate 6+). */
  json?: boolean;
  /** Fixed-length character column; Hibernate needs this to validate CHAR(n) against a String. */
  fixedChar?: 'CHAR' | 'NCHAR';
  /** Exact SQL type for `@Column(columnDefinition)`, where Hibernate cannot infer a matching type. */
  columnDefinition?: string;
  /** Set when no exact mapping exists; the generator adds a TODO comment. */
  unmapped?: boolean;
}

type M = () => JavaTypeMapping;

const T = (javaType: string, ...imports: string[]): JavaTypeMapping => ({ javaType, imports });
const BIG_DECIMAL: M = () => T('BigDecimal', 'java.math.BigDecimal');
const STRING: M = () => T('String');
const BYTES: M = () => T('byte[]');
const LOCAL_DATE: M = () => T('LocalDate', 'java.time.LocalDate');
const LOCAL_TIME: M = () => T('LocalTime', 'java.time.LocalTime');
const LOCAL_DATE_TIME: M = () => T('LocalDateTime', 'java.time.LocalDateTime');
const OFFSET_DATE_TIME: M = () => T('OffsetDateTime', 'java.time.OffsetDateTime');
const OFFSET_TIME: M = () => T('OffsetTime', 'java.time.OffsetTime');
const UUID: M = () => T('UUID', 'java.util.UUID');
const DURATION: M = () => T('Duration', 'java.time.Duration');
const JSON_STRING: M = () => ({ ...T('String'), json: true });
const LOB_STRING: M = () => ({ ...T('String'), lob: true });
const LOB_BYTES: M = () => ({ ...T('byte[]'), lob: true });
const UNMAPPED: M = () => ({ ...T('String'), unmapped: true });
const CHAR: M = () => ({ ...T('String'), fixedChar: 'CHAR' });
const NCHAR: M = () => ({ ...T('String'), fixedChar: 'NCHAR' });

/** PostgreSQL `udt_name` → Java type. */
const PG_TYPES: Record<string, M> = {
  int2: () => T('Short'), smallint: () => T('Short'), smallserial: () => T('Short'),
  int4: () => T('Integer'), integer: () => T('Integer'), serial: () => T('Integer'),
  int8: () => T('Long'), bigint: () => T('Long'), bigserial: () => T('Long'), oid: () => T('Long'),
  float4: () => T('Float'), real: () => T('Float'),
  float8: () => T('Double'), 'double precision': () => T('Double'),
  numeric: BIG_DECIMAL, decimal: BIG_DECIMAL, money: BIG_DECIMAL,
  bool: () => T('Boolean'), boolean: () => T('Boolean'),
  varchar: STRING, bpchar: CHAR, char: CHAR, text: STRING, citext: STRING, name: STRING, xml: STRING,
  inet: STRING, cidr: STRING, macaddr: STRING, tsvector: STRING, ltree: STRING,
  interval: DURATION,
  date: LOCAL_DATE, time: LOCAL_TIME, timetz: OFFSET_TIME, timestamp: LOCAL_DATE_TIME, timestamptz: OFFSET_DATE_TIME,
  uuid: UUID,
  bytea: BYTES,
  json: JSON_STRING, jsonb: JSON_STRING,
};

/** MySQL / MariaDB `data_type` → Java type (signed variants). */
const MYSQL_TYPES: Record<string, M> = {
  tinyint: () => T('Byte'), smallint: () => T('Short'), mediumint: () => T('Integer'),
  int: () => T('Integer'), integer: () => T('Integer'), bigint: () => T('Long'),
  float: () => T('Float'), double: () => T('Double'), real: () => T('Double'),
  decimal: BIG_DECIMAL, numeric: BIG_DECIMAL,
  bool: () => T('Boolean'), boolean: () => T('Boolean'),
  char: CHAR, varchar: STRING,
  binary: BYTES, varbinary: BYTES,
  date: LOCAL_DATE, time: LOCAL_TIME, datetime: LOCAL_DATE_TIME, timestamp: LOCAL_DATE_TIME,
  year: () => T('Short'),
  json: JSON_STRING,
  uuid: UUID, // MariaDB 10.7+
  inet4: STRING, inet6: STRING,
};

const MYSQL_UNSIGNED: Record<string, M> = {
  tinyint: () => T('Short'),
  smallint: () => T('Integer'),
  mediumint: () => T('Integer'),
  int: () => T('Long'),
  integer: () => T('Long'),
  // Hibernate maps BigInteger to NUMERIC, which fails schema validation; Long covers every realistic id.
  bigint: () => T('Long'),
};

/** SQL Server system type → Java type. */
const MSSQL_TYPES: Record<string, M> = {
  bit: () => T('Boolean'), tinyint: () => T('Short'), smallint: () => T('Short'), int: () => T('Integer'), bigint: () => T('Long'),
  decimal: BIG_DECIMAL, numeric: BIG_DECIMAL, money: BIG_DECIMAL, smallmoney: BIG_DECIMAL,
  float: () => T('Double'), real: () => T('Float'),
  char: CHAR, varchar: STRING, nchar: NCHAR, nvarchar: STRING, sysname: STRING, xml: STRING,
  'varchar(max)': STRING, 'nvarchar(max)': STRING, text: LOB_STRING, ntext: LOB_STRING,
  binary: BYTES, varbinary: BYTES, 'varbinary(max)': BYTES, image: LOB_BYTES, timestamp: BYTES, rowversion: BYTES,
  date: LOCAL_DATE, time: LOCAL_TIME, datetime: LOCAL_DATE_TIME, datetime2: LOCAL_DATE_TIME, smalldatetime: LOCAL_DATE_TIME,
  datetimeoffset: OFFSET_DATE_TIME,
  uniqueidentifier: UUID,
  json: JSON_STRING,
};

/** Oracle type (precision/length stripped, lower-case) → Java type. NUMBER is handled separately. */
const ORACLE_TYPES: Record<string, M> = {
  varchar2: STRING, nvarchar2: STRING, char: CHAR, nchar: NCHAR, varchar: STRING, long: STRING, rowid: STRING, urowid: STRING,
  clob: LOB_STRING, nclob: LOB_STRING,
  blob: LOB_BYTES, raw: BYTES, 'long raw': BYTES,
  float: () => T('Double'),
  binary_float: () => ({ ...T('Float'), columnDefinition: 'binary_float' }),
  binary_double: () => ({ ...T('Double'), columnDefinition: 'binary_double' }),
  date: LOCAL_DATE_TIME, // Oracle DATE carries a time component
  timestamp: LOCAL_DATE_TIME,
  'timestamp with time zone': OFFSET_DATE_TIME,
  'timestamp with local time zone': OFFSET_DATE_TIME,
  'interval day to second': DURATION,
  boolean: () => T('Boolean'), // 23ai
  json: JSON_STRING,
};

/** `java.sql.Types` code → Java type, used for every JDBC-bridged database. */
const JDBC_TYPES: Record<number, M> = {
  [-7]: () => T('Boolean'), 16: () => T('Boolean'),
  [-6]: () => T('Short'), 5: () => T('Short'), 4: () => T('Integer'), [-5]: () => T('Long'),
  6: () => T('Double'), 7: () => T('Float'), 8: () => T('Double'),
  2: BIG_DECIMAL, 3: BIG_DECIMAL,
  1: CHAR, 12: STRING, [-1]: STRING, [-15]: NCHAR, [-9]: STRING, [-16]: STRING, 2009: STRING,
  2005: LOB_STRING, 2011: LOB_STRING,
  [-2]: BYTES, [-3]: BYTES, [-4]: BYTES, 2004: LOB_BYTES,
  91: LOCAL_DATE, 92: LOCAL_TIME, 93: LOCAL_DATE_TIME, 2013: OFFSET_TIME, 2014: OFFSET_DATE_TIME,
};

export function mapColumnType(col: ColumnInfo, kind: DbKind): JavaTypeMapping {
  switch (kind) {
    case 'postgresql':
      return mapPostgres(col);
    case 'mysql':
    case 'mariadb':
      return mapMysql(col);
    case 'sqlserver':
      return (MSSQL_TYPES[col.dataType.toLowerCase()] ?? UNMAPPED)();
    case 'oracle':
      return mapOracle(col);
    default:
      return mapJdbc(col);
  }
}

function mapPostgres(col: ColumnInfo): JavaTypeMapping {
  const type = col.dataType.toLowerCase();
  if (type.startsWith('_')) {
    const element = mapPostgres({ ...col, dataType: type.substring(1) });
    if (element.unmapped || element.javaType === 'byte[]' || element.json) {
      return UNMAPPED();
    }
    return { javaType: element.javaType + '[]', imports: element.imports };
  }
  if (type === 'bit' || type === 'varbit') {
    return col.length === 1 && type === 'bit' ? T('Boolean') : T('String');
  }
  return (PG_TYPES[type] ?? UNMAPPED)();
}

function mapMysql(col: ColumnInfo): JavaTypeMapping {
  const type = col.dataType.toLowerCase();
  if (type === 'tinyint' && col.length === 1 && !col.unsigned) {
    return T('Boolean');
  }
  if (type === 'bit') {
    return (col.precision ?? col.length ?? 1) <= 1 ? T('Boolean') : BYTES();
  }
  if (col.unsigned && MYSQL_UNSIGNED[type]) {
    const widened = MYSQL_UNSIGNED[type]();
    // Widened to a larger Java type: state the real column type so schema validation matches.
    return type === 'bigint' ? widened : { ...widened, columnDefinition: `${type} unsigned` };
  }
  // ENUM/SET and the TEXT/BLOB families carry their exact type so Hibernate's schema validation accepts them.
  if (/^(enum|set|tinytext|text|mediumtext|longtext)$/.test(type)) {
    return { ...T('String'), columnDefinition: col.displayType };
  }
  if (/^(tinyblob|blob|mediumblob|longblob)$/.test(type)) {
    return { ...T('byte[]'), columnDefinition: type };
  }
  const m = MYSQL_TYPES[type];
  if (m) {
    return m();
  }
  if (/^(geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection)$/.test(type)) {
    return { ...BYTES(), unmapped: true };
  }
  return UNMAPPED();
}

/** Oracle NUMBER(p,s): integral precisions map to Boolean/Integer/Long/BigInteger, everything else to BigDecimal. */
export function mapOracleNumber(precision: number | null, scale: number | null): JavaTypeMapping {
  if (scale === 0 || (scale === null && precision !== null)) {
    if (precision === null) {
      return T('Long'); // INTEGER / NUMBER(*,0)
    }
    if (precision === 1) {
      return T('Boolean');
    }
    if (precision <= 9) {
      return T('Integer');
    }
    if (precision <= 19) { // Hibernate itself maps Long to NUMBER(19)
      return T('Long');
    }
    return T('BigInteger', 'java.math.BigInteger');
  }
  return BIG_DECIMAL();
}

function mapOracle(col: ColumnInfo): JavaTypeMapping {
  const type = col.dataType.toLowerCase();
  if (type === 'number' || type === 'integer') {
    return mapOracleNumber(col.precision, type === 'integer' ? 0 : col.scale);
  }
  if (type.startsWith('timestamp') && /with local time zone/.test(type)) {
    return OFFSET_DATE_TIME();
  }
  return (ORACLE_TYPES[type] ?? UNMAPPED)();
}

/** Declared type name → `java.sql.Types` code, for drivers that do not report a precise type. */
const JDBC_NAME_HINTS: Array<[RegExp, number]> = [
  [/^(timestamp|datetime).*(with time zone|tz)/, 2014],
  [/^(timestamp|datetime)/, 93],
  [/^date$/, 91],
  [/^time$/, 92],
  [/^(bool|boolean)$/, 16],
  [/^(decimal|numeric)/, 3],
  [/^(bigint|int8)$/, -5],
  [/^(int|integer|int4|mediumint)$/, 4],
  [/^(smallint|int2|tinyint)$/, 5],
  [/^(real|float4)$/, 7],
  [/^(double|float|float8)/, 8],
  [/^(blob|binary|varbinary|bytea)/, -3],
];

function mapJdbc(col: ColumnInfo): JavaTypeMapping {
  const name = col.dataType.toLowerCase();
  if (name === 'uuid' || name === 'uniqueidentifier') {
    return UUID();
  }
  if (name === 'json' || name === 'jsonb') {
    return JSON_STRING();
  }
  if (/^interval/.test(name)) {
    return DURATION();
  }
  let code = col.jdbcType ?? 1111;
  // Loosely typed databases (SQLite) report declared types such as TIMESTAMP as VARCHAR/OTHER;
  // trust the declared type name in that case.
  if (code === 12 || code === 1111 || code === 0) {
    code = JDBC_NAME_HINTS.find(([re]) => re.test(name))?.[1] ?? code;
  }
  // Db2 / Derby / Firebird report BIT for a real BOOLEAN; a sized BIT(n>1) is binary data.
  if (code === -7 && col.length !== null && col.length > 1) {
    return BYTES();
  }
  return (JDBC_TYPES[code] ?? UNMAPPED)();
}

const LENGTH_TYPES: Partial<Record<DbKind, string[]>> = {
  postgresql: ['varchar', 'bpchar', 'char'],
  mysql: ['varchar', 'char', 'varbinary', 'binary'],
  mariadb: ['varchar', 'char', 'varbinary', 'binary'],
  sqlserver: ['varchar', 'char', 'nvarchar', 'nchar', 'varbinary', 'binary'],
  oracle: ['varchar2', 'nvarchar2', 'char', 'nchar', 'varchar', 'raw'],
};

/** Whether `@Column(length = …)` is meaningful for this column. */
export function hasLength(col: ColumnInfo, kind: DbKind): boolean {
  if (col.length === null || col.length <= 0) {
    return false;
  }
  const types = LENGTH_TYPES[kind];
  if (types) {
    return types.includes(col.dataType.toLowerCase());
  }
  // JDBC: CHAR, VARCHAR, NCHAR, NVARCHAR, BINARY, VARBINARY
  return [1, 12, -15, -9, -2, -3].includes(col.jdbcType ?? 0);
}

/** Whether `@Column(precision, scale)` is meaningful for this column. */
export function hasPrecision(col: ColumnInfo, kind?: DbKind): boolean {
  if (col.precision === null || col.precision <= 0) {
    return false;
  }
  const type = col.dataType.toLowerCase();
  if (kind === 'oracle') {
    return type === 'number' && mapOracleNumber(col.precision, col.scale).javaType === 'BigDecimal';
  }
  if (['numeric', 'decimal'].includes(type)) {
    return true;
  }
  return col.jdbcType === 2 || col.jdbcType === 3;
}
