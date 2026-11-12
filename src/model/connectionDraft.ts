import { ConnectionConfig, DbKind, dialect } from './types';

/** What the connection form edits; converted to a `ConnectionConfig` on save. */
export interface ConnectionDraft {
  kind: DbKind;
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  ssl: boolean;
  savePassword: boolean;
  jdbcUrl: string;
  driverJars: string[];
  driverClass: string;
}

/** Validates a draft; returns field → message for every problem. Pure, shared with tests. */
export function validateDraft(d: ConnectionDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  const di = dialect(d.kind);
  if (di.target === 'server') {
    if (!d.host.trim()) {
      errors.host = 'Host is required';
    }
    if (!d.host.includes('\\') && (!Number.isInteger(d.port) || d.port < 1 || d.port > 65535)) {
      errors.port = 'Port must be between 1 and 65535';
    }
    if (di.databaseRequired && !d.database.trim()) {
      errors.database = `${di.databaseLabel} is required`;
    }
  } else if (di.target === 'file') {
    if (!d.database.trim()) {
      errors.database = 'Choose the database file';
    }
  } else if (!/^jdbc:[a-z0-9][a-z0-9-]*:/i.test(d.jdbcUrl.trim())) {
    errors.jdbcUrl = 'Enter a JDBC URL, e.g. jdbc:h2:tcp://localhost/~/test';
  }
  if (d.kind === 'jdbc' && d.driverJars.length === 0) {
    errors.driverJars = 'Choose the JDBC driver jar(s)';
  }
  if (di.target === 'server' && !d.user.trim() && d.kind !== 'derby') {
    errors.user = 'User is required';
  }
  return errors;
}

export function defaultConnectionName(d: Pick<ConnectionDraft, 'kind' | 'host' | 'database' | 'jdbcUrl'>): string {
  const di = dialect(d.kind);
  if (di.target === 'file') {
    return d.database.replace(/^.*[\\/]/, '') || di.label;
  }
  if (di.target === 'url') {
    const tail = d.jdbcUrl.replace(/^jdbc:[a-z0-9]+:(\/\/)?/i, '').replace(/[;?].*$/, '');
    return tail ? `${di.label} ${tail.replace(/^.*[\\/]/, '')}` : di.label;
  }
  const db = d.database && !d.database.startsWith('(') ? d.database : '';
  return db ? `${db}@${d.host}` : d.host || di.label;
}

export function draftToConfig(id: string, d: ConnectionDraft): ConnectionConfig {
  const di = dialect(d.kind);
  const config: ConnectionConfig = {
    id,
    name: d.name.trim() || defaultConnectionName({ ...d, host: d.host.trim(), database: d.database.trim(), jdbcUrl: d.jdbcUrl.trim() }),
    kind: d.kind,
    host: di.target === 'server' ? d.host.trim() : '',
    port: di.target === 'server' ? d.port : 0,
    database: d.database.trim(),
    // File databases (SQLite) have no authentication.
    user: di.target === 'file' ? '' : d.user.trim(),
    ssl: di.target === 'server' && d.ssl,
    savePassword: d.savePassword,
  };
  if (di.target === 'url') {
    config.jdbcUrl = d.jdbcUrl.trim();
  }
  if (di.driver === 'jdbc' && d.driverJars.length) {
    config.driverJars = d.driverJars;
  }
  if (d.kind === 'jdbc' && d.driverClass.trim()) {
    config.driverClass = d.driverClass.trim();
  }
  return config;
}
