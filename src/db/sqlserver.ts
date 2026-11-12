import * as mssql from 'mssql';
import { assembleTables, ColumnInfo, ConnectionConfig, ConstraintRow, TableInfo, TableSummary } from '../model/types';
import { DbSession, toNum, toStr } from './session';

export const MSSQL_SCHEMAS_SQL = `
select s.name as name from sys.schemas s
where s.name not in ('sys', 'INFORMATION_SCHEMA', 'guest') and s.name not like 'db[_]%'
order by case when s.name = 'dbo' then 0 else 1 end, s.name`;

export const MSSQL_TABLES_SQL = `
select o.name as name, rtrim(o.type) as type, cast(ep.value as nvarchar(4000)) as comment
from sys.objects o
left join sys.extended_properties ep on ep.major_id = o.object_id and ep.minor_id = 0 and ep.class = 1 and ep.name = 'MS_Description'
where o.schema_id = schema_id(@schema) and o.type in ('U', 'V') and o.is_ms_shipped = 0
order by o.name`;

export const MSSQL_COLUMNS_SQL = `
select o.name as table_name, c.name as column_name, type_name(c.system_type_id) as data_type,
       type_name(c.user_type_id) as user_type, c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity,
       dc.definition as default_value, cast(ep.value as nvarchar(4000)) as comment
from sys.columns c
join sys.objects o on o.object_id = c.object_id
left join sys.default_constraints dc on dc.object_id = c.default_object_id
left join sys.extended_properties ep on ep.major_id = c.object_id and ep.minor_id = c.column_id and ep.class = 1 and ep.name = 'MS_Description'
where o.schema_id = schema_id(@schema) and o.type in ('U', 'V') and o.is_ms_shipped = 0
order by o.name, c.column_id`;

export const MSSQL_CONSTRAINTS_SQL = `
select o.name as table_name, case kc.type when 'PK' then 'p' else 'u' end as type, kc.name as name,
       col.name as column_name, null as ref_schema, null as ref_table, null as ref_column, ic.key_ordinal as ord
from sys.key_constraints kc
join sys.objects o on o.object_id = kc.parent_object_id
join sys.index_columns ic on ic.object_id = kc.parent_object_id and ic.index_id = kc.unique_index_id
join sys.columns col on col.object_id = ic.object_id and col.column_id = ic.column_id
where o.schema_id = schema_id(@schema)
union all
select o.name, 'f', fk.name, pc.name, rs.name, ro.name, rc.name, fkc.constraint_column_id
from sys.foreign_keys fk
join sys.foreign_key_columns fkc on fkc.constraint_object_id = fk.object_id
join sys.objects o on o.object_id = fk.parent_object_id
join sys.columns pc on pc.object_id = fkc.parent_object_id and pc.column_id = fkc.parent_column_id
join sys.objects ro on ro.object_id = fk.referenced_object_id
join sys.schemas rs on rs.schema_id = ro.schema_id
join sys.columns rc on rc.object_id = fkc.referenced_object_id and rc.column_id = fkc.referenced_column_id
where o.schema_id = schema_id(@schema)
order by 1, 3, 8`;

type Row = Record<string, unknown>;

export function mapMssqlTableSummary(schema: string, r: Row): TableSummary {
  return { schema, name: toStr(r.name)!, kind: toStr(r.type) === 'V' ? 'view' : 'table', comment: toStr(r.comment) };
}

const WIDE_CHAR = new Set(['nchar', 'nvarchar']);
const SIZED = new Set(['char', 'varchar', 'nchar', 'nvarchar', 'binary', 'varbinary']);

export function mapMssqlColumn(r: Row): ColumnInfo {
  const dataType = (toStr(r.data_type) ?? '').toLowerCase();
  const maxLength = toNum(r.max_length);
  let length: number | null = null;
  if (SIZED.has(dataType) && maxLength !== null && maxLength > 0) {
    length = WIDE_CHAR.has(dataType) ? maxLength / 2 : maxLength;
  }
  const precision = ['decimal', 'numeric'].includes(dataType) ? toNum(r.precision) : null;
  let displayType = toStr(r.user_type) ?? dataType;
  if (SIZED.has(dataType)) {
    displayType += `(${maxLength === -1 ? 'max' : length})`;
  } else if (precision !== null) {
    displayType += `(${precision},${toNum(r.scale) ?? 0})`;
  }
  return {
    name: toStr(r.column_name)!,
    // varchar(max) & co. are treated like the classic LOB types.
    dataType: maxLength === -1 && SIZED.has(dataType) ? `${dataType}(max)` : dataType,
    displayType,
    length,
    precision,
    scale: precision !== null ? toNum(r.scale) : null,
    nullable: Boolean(r.is_nullable),
    autoIncrement: Boolean(r.is_identity),
    unsigned: false,
    defaultValue: toStr(r.default_value),
    comment: toStr(r.comment),
  };
}

export function assembleMssqlTables(schema: string, tableRows: Row[], columnRows: Row[], constraintRows: Row[]): TableInfo[] {
  return assembleTables(
    tableRows.map(r => mapMssqlTableSummary(schema, r)),
    columnRows.map(r => ({ table: toStr(r.table_name)!, column: mapMssqlColumn(r) })),
    constraintRows.map(r => ({
      table: toStr(r.table_name)!, type: toStr(r.type) as ConstraintRow['type'], name: toStr(r.name)!,
      column: toStr(r.column_name)!, refSchema: toStr(r.ref_schema), refTable: toStr(r.ref_table), refColumn: toStr(r.ref_column),
    })),
  );
}

/** Splits `host\INSTANCE` into server and instance name. */
export function splitInstance(host: string): { server: string; instanceName?: string } {
  const idx = host.indexOf('\\');
  return idx < 0 ? { server: host } : { server: host.substring(0, idx), instanceName: host.substring(idx + 1) };
}

export class SqlServerSession implements DbSession {
  private readonly pool: mssql.ConnectionPool;
  private connecting: Promise<mssql.ConnectionPool> | undefined;

  constructor(readonly config: ConnectionConfig, password: string | undefined) {
    const { server, instanceName } = splitInstance(config.host);
    this.pool = new mssql.ConnectionPool({
      server,
      port: instanceName ? undefined : config.port,
      database: config.database || undefined,
      user: config.user,
      password: password ?? '',
      connectionTimeout: 10_000,
      requestTimeout: 60_000,
      pool: { max: 3, min: 0, idleTimeoutMillis: 60_000 },
      options: {
        encrypt: config.ssl,
        // Development servers mostly use self-signed certificates.
        trustServerCertificate: true,
        instanceName,
        appName: 'JPA Power Tools',
      },
    });
    this.pool.on('error', () => undefined);
  }

  private async rows(sql: string, schema?: string): Promise<Row[]> {
    this.connecting ??= this.pool.connect();
    try {
      await this.connecting;
    } catch (e) {
      this.connecting = undefined;
      throw e;
    }
    const req = this.pool.request();
    if (schema !== undefined) {
      req.input('schema', mssql.NVarChar, schema);
    }
    const res = await req.query(sql);
    return res.recordset as Row[];
  }

  async serverVersion(): Promise<string> {
    const [r] = await this.rows(`select cast(serverproperty('ProductVersion') as nvarchar(64)) as v,
      cast(serverproperty('Edition') as nvarchar(128)) as e`);
    return `SQL Server ${r.v} (${String(r.e).replace(/\s*\(.*$/, '')})`;
  }

  async listSchemas(): Promise<string[]> {
    return (await this.rows(MSSQL_SCHEMAS_SQL)).map(r => String(r.name));
  }

  async listTables(schema: string): Promise<TableSummary[]> {
    return (await this.rows(MSSQL_TABLES_SQL, schema)).map(r => mapMssqlTableSummary(schema, r));
  }

  async loadTables(schema: string, names?: string[]): Promise<TableInfo[]> {
    const [tables, columns, constraints] = await Promise.all([
      this.rows(MSSQL_TABLES_SQL, schema),
      this.rows(MSSQL_COLUMNS_SQL, schema),
      this.rows(MSSQL_CONSTRAINTS_SQL, schema),
    ]);
    const wanted = names && names.length ? tables.filter(r => names.includes(String(r.name))) : tables;
    return assembleMssqlTables(schema, wanted, columns, constraints);
  }

  defaultSchema(): string {
    return 'dbo';
  }

  async close(): Promise<void> {
    await this.pool.close().catch(() => undefined);
  }
}
