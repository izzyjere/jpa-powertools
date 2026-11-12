import { Pool } from 'pg';
import { assembleTables, ColumnInfo, ConnectionConfig, ConstraintRow, TableInfo, TableSummary } from '../model/types';
import { DbSession, toNum, toStr } from './session';

export const PG_SCHEMAS_SQL = `
select n.nspname as name
from pg_catalog.pg_namespace n
where n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
  and has_schema_privilege(n.oid, 'USAGE')
order by (n.nspname = 'public') desc, n.nspname`;

export const PG_TABLES_SQL = `
select c.relname as name, c.relkind as relkind, pg_catalog.obj_description(c.oid, 'pg_class') as comment
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm', 'f') and not c.relispartition
order by c.relname`;

export const PG_COLUMNS_SQL = `
select c.table_name, c.column_name, c.data_type, c.udt_name, c.character_maximum_length,
       c.numeric_precision, c.numeric_scale, c.is_nullable, c.column_default, c.is_identity,
       pg_catalog.format_type(a.atttypid, a.atttypmod) as display_type,
       pg_catalog.col_description(cl.oid, a.attnum) as comment
from information_schema.columns c
join pg_catalog.pg_namespace n on n.nspname = c.table_schema
join pg_catalog.pg_class cl on cl.relnamespace = n.oid and cl.relname = c.table_name
join pg_catalog.pg_attribute a on a.attrelid = cl.oid and a.attname = c.column_name
where c.table_schema = $1 and ($2::text[] is null or c.table_name = any($2::text[]))
order by c.table_name, c.ordinal_position`;

export const PG_CONSTRAINTS_SQL = `
select con.conname as name, con.contype as type, cl.relname as table_name,
       rn.nspname as ref_schema, rcl.relname as ref_table,
       array(select a.attname from unnest(con.conkey) with ordinality k(attnum, ord)
             join pg_catalog.pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
             order by k.ord)::text[] as columns,
       array(select a.attname from unnest(con.confkey) with ordinality k(attnum, ord)
             join pg_catalog.pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum
             order by k.ord)::text[] as ref_columns
from pg_catalog.pg_constraint con
join pg_catalog.pg_class cl on cl.oid = con.conrelid
join pg_catalog.pg_namespace n on n.oid = cl.relnamespace
left join pg_catalog.pg_class rcl on rcl.oid = con.confrelid
left join pg_catalog.pg_namespace rn on rn.oid = rcl.relnamespace
where n.nspname = $1 and con.contype in ('p', 'f', 'u')
  and ($2::text[] is null or cl.relname = any($2::text[]))
order by cl.relname, con.conname`;

type Row = Record<string, unknown>;

export function mapPgTableSummary(schema: string, r: Row): TableSummary {
  const relkind = toStr(r.relkind);
  return { schema, name: toStr(r.name)!, kind: relkind === 'v' || relkind === 'm' ? 'view' : 'table', comment: toStr(r.comment) };
}

export function mapPgColumn(r: Row): ColumnInfo {
  const def = toStr(r.column_default);
  const udt = (toStr(r.udt_name) ?? '').toLowerCase();
  const dataType = toStr(r.data_type) === 'ARRAY' ? udt : udt || (toStr(r.data_type) ?? '').toLowerCase();
  return {
    name: toStr(r.column_name)!,
    dataType,
    displayType: toStr(r.display_type) ?? dataType,
    length: toNum(r.character_maximum_length),
    precision: toNum(r.numeric_precision),
    scale: toNum(r.numeric_scale),
    nullable: toStr(r.is_nullable) === 'YES',
    autoIncrement: toStr(r.is_identity) === 'YES' || (def !== null && /^nextval\(/i.test(def)),
    unsigned: false,
    defaultValue: def,
    comment: toStr(r.comment),
  };
}

function toArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map(String);
  }
  // Fallback for un-parsed array literals: {a,b}
  const s = toStr(v);
  return s ? s.replace(/^\{|\}$/g, '').split(',').filter(Boolean).map(x => x.replace(/^"|"$/g, '')) : [];
}

/** Assembles full table metadata from the raw result rows of the three introspection queries. */
export function assemblePgTables(schema: string, tableRows: Row[], columnRows: Row[], constraintRows: Row[]): TableInfo[] {
  const constraints: ConstraintRow[] = [];
  for (const r of constraintRows) {
    const type = toStr(r.type) as 'p' | 'u' | 'f';
    const cols = toArray(r.columns);
    const refCols = toArray(r.ref_columns);
    cols.forEach((column, i) => constraints.push({
      table: toStr(r.table_name)!, type, name: toStr(r.name)!, column,
      refSchema: toStr(r.ref_schema), refTable: toStr(r.ref_table), refColumn: refCols[i] ?? null,
    }));
  }
  return assembleTables(
    tableRows.map(r => mapPgTableSummary(schema, r)),
    columnRows.map(r => ({ table: toStr(r.table_name)!, column: mapPgColumn(r) })),
    constraints,
  );
}

export class PostgresSession implements DbSession {
  private readonly pool: Pool;

  constructor(readonly config: ConnectionConfig, password: string | undefined) {
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database || 'postgres',
      user: config.user,
      password: password ?? '',
      // Encrypts traffic without verifying the server certificate (common for dev databases).
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 60_000,
      max: 3,
      application_name: 'JPA Power Tools',
    });
    // An idle client error must never crash the extension host; the next query reconnects.
    this.pool.on('error', () => undefined);
  }

  async serverVersion(): Promise<string> {
    const r = await this.pool.query('select version() as v');
    const full = String(r.rows[0].v);
    return /^PostgreSQL [\d.]+/.exec(full)?.[0] ?? full;
  }

  async listSchemas(): Promise<string[]> {
    const r = await this.pool.query(PG_SCHEMAS_SQL);
    return r.rows.map(row => String(row.name));
  }

  async listTables(schema: string): Promise<TableSummary[]> {
    const r = await this.pool.query(PG_TABLES_SQL, [schema]);
    return r.rows.map(row => mapPgTableSummary(schema, row));
  }

  async loadTables(schema: string, names?: string[]): Promise<TableInfo[]> {
    const filter = names && names.length ? names : null;
    const [tables, columns, constraints] = await Promise.all([
      this.pool.query(PG_TABLES_SQL, [schema]),
      this.pool.query(PG_COLUMNS_SQL, [schema, filter]),
      this.pool.query(PG_CONSTRAINTS_SQL, [schema, filter]),
    ]);
    const wanted = filter ? tables.rows.filter(r => filter.includes(String(r.name))) : tables.rows;
    return assemblePgTables(schema, wanted, columns.rows, constraints.rows);
  }

  defaultSchema(): string {
    return 'public';
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => undefined);
  }
}
