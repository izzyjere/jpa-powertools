import { ConnectionConfig, TableInfo, TableSummary } from '../model/types';

/** A live, pooled connection to one database, able to introspect its schema. */
export interface DbSession {
  readonly config: ConnectionConfig;
  serverVersion(): Promise<string>;
  /** Schemas (PostgreSQL) or databases (MySQL/MariaDB) the user can browse. */
  listSchemas(): Promise<string[]>;
  listTables(schema: string): Promise<TableSummary[]>;
  /** Full metadata for the given tables (all tables of the schema when `names` is omitted). */
  loadTables(schema: string, names?: string[]): Promise<TableInfo[]>;
  /** The schema whose name does not need to be written into `@Table`. */
  defaultSchema(schema: string): string;
  close(): Promise<void>;
}

/** Turns driver errors into short, actionable messages for the UI. */
export function friendlyError(err: unknown, config: Pick<ConnectionConfig, 'host' | 'port' | 'database' | 'user'>): string {
  const e = err as { code?: string; message?: string; errno?: number };
  const code = e?.code ?? '';
  const msg = e?.message ?? String(err);
  const where = `${config.host}:${config.port}`;
  switch (code) {
    case 'ECONNREFUSED':
      return `Connection refused at ${where}. Is the database server running and listening on that port?`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Host "${config.host}" could not be resolved. Check the host name.`;
    case 'ETIMEDOUT':
    case 'ECONNRESET':
      return `Timed out connecting to ${where}. Check the host, port and any firewall or VPN.`;
    case '28P01': // pg invalid_password
    case '28000': // pg invalid_authorization_specification
    case 'ER_ACCESS_DENIED_ERROR':
    case 'ER_ACCESS_DENIED_NO_PASSWORD_ERROR':
      return `Authentication failed for user "${config.user}". Check the user name and password.`;
    case '3D000': // pg invalid_catalog_name
    case 'ER_BAD_DB_ERROR':
      return `Database "${config.database}" does not exist on ${where}.`;
    case 'ER_DBACCESS_DENIED_ERROR':
      return `User "${config.user}" has no access to database "${config.database}".`;
  }
  if (code === 'ELOGIN' || /Login failed for user|password authentication failed|ORA-01017|Access denied for user|\[28\w{3}\]|invalid (user ?name|password|authorization)|SQLCODE=-30082|Your user name and password are not defined/i.test(msg)) {
    return `Authentication failed for user "${config.user}". Check the user name and password.`;
  }
  if (/ECONNREFUSED|Connection refused|NJS-503|NJS-511/i.test(msg)) {
    return `Connection refused at ${where}. Is the database server running and listening on that port?`;
  }
  if (/ORA-12514|ORA-12505|NJS-518/i.test(msg)) {
    return `The listener at ${where} does not know service "${config.database}". Check the service name (e.g. FREEPDB1, XEPDB1).`;
  }
  if (/Cannot open database|SQLCODE=-1013|database .* not found|Database .* does not exist/i.test(msg)) {
    return `Database "${config.database}" was not found on ${where}, or the user cannot open it.`;
  }
  if (/timeout|timed out|NJS-510|ETIMEOUT/i.test(msg)) {
    return `Timed out connecting to ${where}. Check the host, port and any firewall or VPN.`;
  }
  if (/does not support SSL|server does not support ssl/i.test(msg)) {
    return 'The server does not support SSL. Turn off "Use SSL" and try again.';
  }
  if (/no pg_hba\.conf entry/i.test(msg)) {
    return `${msg}. The server may require SSL; try enabling "Use SSL".`;
  }
  return msg;
}

export function toStr(v: unknown): string | null {
  if (v === null || v === undefined) {
    return null;
  }
  if (Buffer.isBuffer(v)) {
    return v.toString('utf8');
  }
  return String(v);
}

export function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') {
    return null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
