import type { Pool } from 'oracledb';
import { assembleTables, ColumnInfo, ConnectionConfig, ConstraintRow, TableInfo, TableSummary } from '../model/types';
import { DbSession, toNum, toStr } from './session';

export const ORACLE_SCHEMAS_SQL = `
select u.username as "name" from all_users u
where u.oracle_maintained = 'N'
  and (u.username = user or exists (
       select 1 from all_objects o where o.owner = u.username and o.object_type in ('TABLE', 'VIEW')))
order by case when u.username = user then 0 else 1 end, u.username`;

export const ORACLE_TABLES_SQL = `
select o.object_name as "name", o.object_type as "type", c.comments as "comment"
from all_objects o
left join all_tab_comments c on c.owner = o.owner and c.table_name = o.object_name
where o.owner = :schema and o.object_type in ('TABLE', 'VIEW') and o.generated = 'N'
  and o.object_name not like 'BIN$%'
  and not exists (select 1 from all_mviews m where m.owner = o.owner and m.mview_name = o.object_name and o.object_type = 'TABLE')
order by o.object_name`;

export const ORACLE_COLUMNS_SQL = `
select c.table_name as "table_name", c.column_name as "column_name", c.data_type as "data_type",
       c.char_length as "char_length", c.data_length as "data_length", c.data_precision as "precision",
       c.data_scale as "scale", c.nullable as "nullable", c.identity_column as "identity", cc.comments as "comment"
from all_tab_columns c
left join all_col_comments cc on cc.owner = c.owner and cc.table_name = c.table_name and cc.column_name = c.column_name
where c.owner = :schema
order by c.table_name, c.column_id`;

export const ORACLE_CONSTRAINTS_SQL = `
select c.table_name as "table_name", c.constraint_type as "type", c.constraint_name as "name",
       cc.column_name as "column_name", r.owner as "ref_schema", r.table_name as "ref_table", rcc.column_name as "ref_column"
from all_constraints c
join all_cons_columns cc on cc.owner = c.owner and cc.constraint_name = c.constraint_name and cc.table_name = c.table_name
left join all_constraints r on r.owner = c.r_owner and r.constraint_name = c.r_constraint_name
left join all_cons_columns rcc on rcc.owner = r.owner and rcc.constraint_name = r.constraint_name and rcc.position = cc.position
where c.owner = :schema and c.constraint_type in ('P', 'U', 'R')
order by c.table_name, c.constraint_name, cc.position`;

type Row = Record<string, unknown>;

export function mapOracleTableSummary(schema: string, r: Row): TableSummary {
  return { schema, name: toStr(r.name)!, kind: toStr(r.type) === 'VIEW' ? 'view' : 'table', comment: toStr(r.comment) };
}

export function mapOracleColumn(r: Row): ColumnInfo {
  const rawType = toStr(r.data_type) ?? '';
  // TIMESTAMP(6) WITH TIME ZONE → "timestamp with time zone"; INTERVAL DAY(2) TO SECOND(6) → "interval day to second"
  const dataType = rawType.replace(/\(\d+\)/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const charLength = toNum(r.char_length);
  const isChar = /char/.test(dataType);
  const isRaw = dataType === 'raw';
  const length = isChar && charLength ? charLength : isRaw ? toNum(r.data_length) : null;
  const precision = toNum(r.precision);
  const scale = toNum(r.scale);
  let displayType = rawType;
  if (length !== null) {
    displayType += `(${length})`;
  } else if (dataType === 'number' && precision !== null) {
    displayType += scale ? `(${precision},${scale})` : `(${precision})`;
  }
  return {
    name: toStr(r.column_name)!,
    dataType,
    displayType,
    length,
    precision,
    scale,
    nullable: toStr(r.nullable) !== 'N',
    autoIncrement: toStr(r.identity) === 'YES',
    unsigned: false,
    defaultValue: null,
    comment: toStr(r.comment),
  };
}

export function assembleOracleTables(schema: string, tableRows: Row[], columnRows: Row[], constraintRows: Row[]): TableInfo[] {
  const typeOf: Record<string, ConstraintRow['type']> = { P: 'p', U: 'u', R: 'f' };
  return assembleTables(
    tableRows.map(r => mapOracleTableSummary(schema, r)),
    columnRows.map(r => ({ table: toStr(r.table_name)!, column: mapOracleColumn(r) })),
    constraintRows.filter(r => typeOf[toStr(r.type)!]).map(r => ({
      table: toStr(r.table_name)!, type: typeOf[toStr(r.type)!], name: toStr(r.name)!, column: toStr(r.column_name)!,
      refSchema: toStr(r.ref_schema), refTable: toStr(r.ref_table), refColumn: toStr(r.ref_column),
    })),
  );
}

/** Easy Connect string; a database containing ':' or '(' is passed through as a full connect descriptor. */
export function oracleConnectString(config: Pick<ConnectionConfig, 'host' | 'port' | 'database' | 'ssl'>): string {
  if (/^\(|^[\w.-]+:\d+[/:]/.test(config.database)) {
    return config.database;
  }
  const protocol = config.ssl ? 'tcps://' : '';
  return `${protocol}${config.host}:${config.port}/${config.database}?connect_timeout=10`;
}

export class OracleSession implements DbSession {
  private pool: Promise<Pool> | undefined;

  constructor(readonly config: ConnectionConfig, private readonly password: string | undefined) {}

  private getPool(): Promise<Pool> {
    if (!this.pool) {
      // Loaded lazily: the module is large and only needed for Oracle connections.
      const oracledb = require('oracledb') as typeof import('oracledb');
      oracledb.fetchAsString = [oracledb.CLOB];
      this.pool = oracledb.createPool({
        user: this.config.user,
        password: this.password ?? '',
        connectString: oracleConnectString(this.config),
        poolMin: 0,
        poolMax: 3,
        poolTimeout: 60,
        // Without this, Thin mode verifies certificates; dev databases usually have self-signed ones.
        sslServerDNMatch: false,
      });
      this.pool.catch(() => (this.pool = undefined));
    }
    return this.pool;
  }

  private async withConnection<T>(fn: (c: import('oracledb').Connection) => Promise<T>): Promise<T> {
    const conn = await (await this.getPool()).getConnection();
    try {
      return await fn(conn);
    } finally {
      await conn.close().catch(() => undefined);
    }
  }

  private async rows(sql: string, schema?: string): Promise<Row[]> {
    const oracledb = require('oracledb') as typeof import('oracledb');
    return this.withConnection(async c => {
      const res = await c.execute(sql, schema !== undefined ? { schema } : {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      return (res.rows ?? []) as Row[];
    });
  }

  async serverVersion(): Promise<string> {
    return this.withConnection(async c => `Oracle ${c.oracleServerVersionString}`);
  }

  async listSchemas(): Promise<string[]> {
    return (await this.rows(ORACLE_SCHEMAS_SQL)).map(r => String(r.name));
  }

  async listTables(schema: string): Promise<TableSummary[]> {
    return (await this.rows(ORACLE_TABLES_SQL, schema)).map(r => mapOracleTableSummary(schema, r));
  }

  async loadTables(schema: string, names?: string[]): Promise<TableInfo[]> {
    // Sequential: the pool is small and these dictionary queries are heavy.
    const tables = await this.rows(ORACLE_TABLES_SQL, schema);
    const columns = await this.rows(ORACLE_COLUMNS_SQL, schema);
    const constraints = await this.rows(ORACLE_CONSTRAINTS_SQL, schema);
    const wanted = names && names.length ? tables.filter(r => names.includes(String(r.name))) : tables;
    return assembleOracleTables(schema, wanted, columns, constraints);
  }

  defaultSchema(): string {
    return this.config.user.toUpperCase();
  }

  async close(): Promise<void> {
    const p = this.pool;
    this.pool = undefined;
    if (p) {
      await p.then(pool => pool.close(0)).catch(() => undefined);
    }
  }
}
