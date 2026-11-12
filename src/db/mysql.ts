import { createPool, Pool, RowDataPacket } from 'mysql2/promise';
import { assembleTables, ColumnInfo, ConnectionConfig, ConstraintRow, TableInfo, TableSummary } from '../model/types';
import { DbSession, toNum, toStr } from './session';

export const MYSQL_SYSTEM_SCHEMAS = ['mysql', 'information_schema', 'performance_schema', 'sys'];

export const MYSQL_SCHEMAS_SQL = `
select schema_name as name from information_schema.schemata
where schema_name not in ('mysql', 'information_schema', 'performance_schema', 'sys')
order by schema_name`;

export const MYSQL_TABLES_SQL = `
select table_name as name, table_type as type, table_comment as comment
from information_schema.tables where table_schema = ? order by table_name`;

export const MYSQL_COLUMNS_SQL = `
select table_name as tbl, column_name as name, data_type as data_type, column_type as column_type,
       character_maximum_length as len, numeric_precision as prec, numeric_scale as scale,
       is_nullable as nullable, column_default as def, extra as extra, column_comment as comment
from information_schema.columns where table_schema = ?
order by table_name, ordinal_position`;

export const MYSQL_CONSTRAINTS_SQL = `
select tc.constraint_type as type, kcu.constraint_name as name, kcu.table_name as tbl, kcu.column_name as col,
       kcu.referenced_table_schema as ref_schema, kcu.referenced_table_name as ref_table,
       kcu.referenced_column_name as ref_col
from information_schema.key_column_usage kcu
join information_schema.table_constraints tc
  on tc.constraint_schema = kcu.constraint_schema and tc.table_name = kcu.table_name
 and tc.constraint_name = kcu.constraint_name
where kcu.table_schema = ? and tc.constraint_type in ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY')
order by kcu.table_name, kcu.constraint_name, kcu.ordinal_position`;

type Row = Record<string, unknown>;

export function mapMysqlTableSummary(schema: string, r: Row): TableSummary {
  const isView = /VIEW/i.test(toStr(r.type) ?? '');
  const comment = toStr(r.comment);
  return { schema, name: toStr(r.name)!, kind: isView ? 'view' : 'table', comment: isView || !comment ? null : comment };
}

export function mapMysqlColumn(r: Row): ColumnInfo {
  // Keep the original case: ENUM/SET values are case-sensitive and end up in columnDefinition.
  const rawColumnType = toStr(r.column_type) ?? '';
  const columnType = rawColumnType.toLowerCase();
  const dataType = (toStr(r.data_type) ?? '').toLowerCase();
  const displayWidth = /^\w+\((\d+)\)/.exec(columnType);
  let length = toNum(r.len);
  if (length === null && displayWidth && (dataType === 'tinyint' || dataType === 'bit')) {
    length = Number(displayWidth[1]);
  }
  return {
    name: toStr(r.name)!,
    dataType,
    displayType: rawColumnType || dataType,
    length,
    precision: toNum(r.prec),
    scale: toNum(r.scale),
    nullable: toStr(r.nullable) === 'YES',
    autoIncrement: /auto_increment/i.test(toStr(r.extra) ?? ''),
    unsigned: /\bunsigned\b/.test(columnType),
    defaultValue: toStr(r.def),
    comment: toStr(r.comment) || null,
  };
}

export function assembleMysqlTables(schema: string, tableRows: Row[], columnRows: Row[], constraintRows: Row[]): TableInfo[] {
  const typeOf: Record<string, ConstraintRow['type']> = { 'PRIMARY KEY': 'p', UNIQUE: 'u', 'FOREIGN KEY': 'f' };
  return assembleTables(
    tableRows.map(r => mapMysqlTableSummary(schema, r)),
    columnRows.map(r => ({ table: toStr(r.tbl)!, column: mapMysqlColumn(r) })),
    constraintRows.filter(r => typeOf[toStr(r.type)!]).map(r => ({
      table: toStr(r.tbl)!, type: typeOf[toStr(r.type)!], name: toStr(r.name)!, column: toStr(r.col)!,
      refSchema: toStr(r.ref_schema) ?? schema, refTable: toStr(r.ref_table), refColumn: toStr(r.ref_col),
    })),
  );
}

export class MysqlSession implements DbSession {
  private readonly pool: Pool;

  constructor(readonly config: ConnectionConfig, password: string | undefined) {
    this.pool = createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: password ?? '',
      database: config.database || undefined,
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      connectTimeout: 10_000,
      connectionLimit: 3,
      maxIdle: 1,
      idleTimeout: 60_000,
      supportBigNumbers: true,
      dateStrings: true,
    });
    // Swallow errors from idle connections; queries surface their own errors.
    (this.pool as unknown as { on(e: string, cb: () => void): void }).on('error', () => undefined);
  }

  private async rows(sql: string, params: unknown[] = []): Promise<Row[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(sql, params);
    return rows as Row[];
  }

  async serverVersion(): Promise<string> {
    const [r] = await this.rows('select version() as v');
    const v = String(r.v);
    return /mariadb/i.test(v) ? `MariaDB ${v.replace(/-MariaDB.*$/i, '')}` : `MySQL ${v}`;
  }

  async listSchemas(): Promise<string[]> {
    if (this.config.database) {
      return [this.config.database];
    }
    return (await this.rows(MYSQL_SCHEMAS_SQL)).map(r => String(r.name));
  }

  async listTables(schema: string): Promise<TableSummary[]> {
    return (await this.rows(MYSQL_TABLES_SQL, [schema])).map(r => mapMysqlTableSummary(schema, r));
  }

  async loadTables(schema: string, names?: string[]): Promise<TableInfo[]> {
    const [tables, columns, constraints] = await Promise.all([
      this.rows(MYSQL_TABLES_SQL, [schema]),
      this.rows(MYSQL_COLUMNS_SQL, [schema]),
      this.rows(MYSQL_CONSTRAINTS_SQL, [schema]),
    ]);
    const wanted = names && names.length ? tables.filter(r => names.includes(String(r.name))) : tables;
    return assembleMysqlTables(schema, wanted, columns, constraints);
  }

  defaultSchema(schema: string): string {
    return this.config.database || schema;
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => undefined);
  }
}
