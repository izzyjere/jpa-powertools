import { assembleTables, ColumnInfo, ConnectionConfig, ConstraintRow, dialect, TableInfo, TableSummary } from '../../model/types';
import { buildJdbcUrl } from '../jdbcUrl';
import { DbSession, toNum, toStr } from '../session';
import { BridgeProcess } from './bridge';
import { JdbcRuntime } from './runtime';

interface ConnectInfo {
  product: string;
  version: string;
  schema: string | null;
  catalog: string | null;
  userName: string | null;
}

type Row = Record<string, unknown>;

const SYSTEM_SCHEMA = /^(information_schema|pg_catalog|pg_toast|sys|sysibm\w*|syscat|sysfun|sysproc|sysstat|systools|syspublic|nullid|sqlj|system_lobs|syscs_\w+|mysql|performance_schema|ctxsys|mdsys|xdb|outln|dbsnmp|appqossys|wmsys|ojvmsys|lbacsys|gsmadmin_internal)$/i;

export function filterSchemas(names: string[], current: string | null): string[] {
  const visible = names.filter(n => n === '' || !SYSTEM_SCHEMA.test(n));
  const list = visible.length ? visible : names;
  return [...new Set(list)].sort((a, b) => Number(b === current) - Number(a === current) || a.localeCompare(b));
}

const TABLE_TYPES = /^(TABLE|BASE TABLE|VIEW|MATERIALIZED VIEW)$/i;

export function mapJdbcTableSummary(schema: string, r: Row): TableSummary | undefined {
  const type = toStr(r.type) ?? '';
  if (!TABLE_TYPES.test(type)) {
    return undefined;
  }
  return { schema, name: toStr(r.name)!, kind: /VIEW/i.test(type) ? 'view' : 'table', comment: toStr(r.comment) || null };
}

const CHAR_TYPES = new Set([1, 12, -1, -15, -9, -16]); // CHAR, VARCHAR, LONGVARCHAR, NCHAR, NVARCHAR, LONGNVARCHAR
const BINARY_TYPES = new Set([-2, -3]); // BINARY, VARBINARY
const DECIMAL_TYPES = new Set([2, 3]); // NUMERIC, DECIMAL

export function mapJdbcColumn(r: Row): ColumnInfo {
  const jdbcType = toNum(r.jdbcType) ?? 1111;
  const typeName = toStr(r.typeName) ?? '';
  const size = toNum(r.size);
  const digits = toNum(r.digits);
  const isChar = CHAR_TYPES.has(jdbcType) && jdbcType !== -1 && jdbcType !== -16;
  // Drivers report "unbounded" text as a huge size (SQLite: 2000000000); that is not a usable column length.
  const length = (isChar || BINARY_TYPES.has(jdbcType)) && size !== null && size > 0 && size <= 1_000_000 ? size : null;
  const isDecimal = DECIMAL_TYPES.has(jdbcType);
  let displayType = typeName;
  if (length !== null && !/\(/.test(typeName)) {
    displayType += `(${length})`;
  } else if (isDecimal && size !== null && !/\(/.test(typeName)) {
    displayType += digits ? `(${size},${digits})` : `(${size})`;
  }
  return {
    name: toStr(r.name)!,
    dataType: typeName.toLowerCase().replace(/\(.*$/, '').trim(),
    displayType,
    jdbcType,
    length,
    precision: isDecimal ? size : null,
    scale: isDecimal ? digits : null,
    nullable: Boolean(r.nullable),
    autoIncrement: Boolean(r.autoIncrement) || /identity|nextval|autoincrement|generated/i.test(toStr(r.default) ?? ''),
    unsigned: /unsigned/i.test(typeName),
    defaultValue: toStr(r.default),
    comment: toStr(r.comment) || null,
  };
}

export function assembleJdbcTables(schema: string, tableRows: Row[], columnRows: Row[], keyRows: Row[]): TableInfo[] {
  const summaries = tableRows.map(r => mapJdbcTableSummary(schema, r)).filter((s): s is TableSummary => !!s);
  // Several unique indexes may back the same constraint; key on name to keep column groups intact.
  return assembleTables(
    summaries,
    columnRows.map(r => ({ table: toStr(r.table)!, column: mapJdbcColumn(r) })),
    keyRows.map(r => ({
      table: toStr(r.table)!, type: toStr(r.type) as ConstraintRow['type'], name: toStr(r.name)!, column: toStr(r.column)!,
      refSchema: toStr(r.refSchema), refTable: toStr(r.refTable), refColumn: toStr(r.refColumn),
    })),
  );
}

/** Session backed by the Java bridge; works with any JDBC driver. */
export class JdbcSession implements DbSession {
  private bridge: BridgeProcess | undefined;
  private connected: Promise<ConnectInfo> | undefined;
  private schemasLoaded = false;
  private cachedDefault: string | undefined;

  constructor(readonly config: ConnectionConfig, private readonly password: string | undefined, private readonly runtime: JdbcRuntime) {}

  get url(): string {
    return buildJdbcUrl(this.config);
  }

  private async ready(): Promise<BridgeProcess> {
    if (!this.connected) {
      const url = this.url;
      if (!url) {
        throw new Error('A JDBC URL is required for this connection.');
      }
      this.bridge = new BridgeProcess(this.runtime);
      const d = dialect(this.config.kind);
      this.connected = this.bridge.request<ConnectInfo>('connect', {
        url,
        user: this.config.user,
        password: this.password ?? '',
        driverClass: this.config.driverClass || (this.config.driverJars?.length ? '' : d.jdbcDriverClass) || '',
      }, 60_000);
      this.connected.catch(() => {
        const b = this.bridge;
        this.bridge = undefined;
        this.connected = undefined;
        b?.close();
      });
    }
    await this.connected;
    return this.bridge!;
  }

  private async info(): Promise<ConnectInfo> {
    await this.ready();
    const i = await this.connected!;
    this.cachedDefault = i.schema ?? i.catalog ?? undefined;
    return i;
  }

  async serverVersion(): Promise<string> {
    const i = await this.info();
    return `${i.product} ${i.version}`.trim();
  }

  async listSchemas(): Promise<string[]> {
    const bridge = await this.ready();
    const names = await bridge.request<string[]>('schemas');
    this.schemasLoaded = true;
    const i = await this.info();
    return filterSchemas(names.map(n => n ?? ''), i.schema ?? i.catalog);
  }

  /** The bridge decides between schemas and catalogs while listing schemas; make sure that happened. */
  private async ensureSchemas(): Promise<BridgeProcess> {
    const bridge = await this.ready();
    if (!this.schemasLoaded) {
      await bridge.request('schemas');
      this.schemasLoaded = true;
    }
    return bridge;
  }

  async listTables(schema: string): Promise<TableSummary[]> {
    const bridge = await this.ensureSchemas();
    const rows = await bridge.request<Row[]>('tables', { schema });
    return rows.map(r => mapJdbcTableSummary(schema, r)).filter((s): s is TableSummary => !!s)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async loadTables(schema: string, names?: string[]): Promise<TableInfo[]> {
    const bridge = await this.ensureSchemas();
    const tableRows = await bridge.request<Row[]>('tables', { schema });
    const wanted = tableRows.filter(r => mapJdbcTableSummary(schema, r) && (!names?.length || names.includes(String(r.name))));
    const columns = await bridge.request<Row[]>('columns', { schema });
    const keys = await bridge.request<Row[]>('keys', { schema, tables: wanted.map(r => String(r.name)) }, 300_000);
    return assembleJdbcTables(schema, wanted, columns, keys);
  }

  /** Known once connected (sessions are verified with `serverVersion()` before use). */
  defaultSchema(schema: string): string {
    return this.cachedDefault ?? schema;
  }

  async close(): Promise<void> {
    const b = this.bridge;
    this.bridge = undefined;
    this.connected = undefined;
    await b?.close();
  }
}
