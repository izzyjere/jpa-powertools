import type { JdbcRuntime } from './jdbc/runtime';
import { ConnectionConfig, dialect } from '../model/types';
import { DbSession } from './session';

/*
 * Drivers are loaded on first use: the extension activates whenever a Java file opens (for JPQL support),
 * and most of those sessions never connect to a database.
 */

/**
 * Creates a session for the connection. JDBC-backed dialects need a `jdbcRuntime`
 * (Java executable + driver jars); native dialects ignore it.
 */
export function openSession(config: ConnectionConfig, password: string | undefined, jdbcRuntime?: JdbcRuntime): DbSession {
  switch (config.kind) {
    case 'postgresql':
      return new (require('./postgres') as typeof import('./postgres')).PostgresSession(config, password);
    case 'mysql':
    case 'mariadb':
      return new (require('./mysql') as typeof import('./mysql')).MysqlSession(config, password);
    case 'sqlserver':
      return new (require('./sqlserver') as typeof import('./sqlserver')).SqlServerSession(config, password);
    case 'oracle':
      return new (require('./oracle') as typeof import('./oracle')).OracleSession(config, password);
    default:
      if (dialect(config.kind).driver !== 'jdbc') {
        throw new Error(`Unsupported database type: ${config.kind}`);
      }
      if (!jdbcRuntime) {
        throw new Error(`${dialect(config.kind).label} connections need the JDBC runtime.`);
      }
      return new (require('./jdbc/jdbcSession') as typeof import('./jdbc/jdbcSession')).JdbcSession(config, password, jdbcRuntime);
  }
}

/** Opens a short-lived session, verifies it works and returns the server version. */
export async function testConnection(config: ConnectionConfig, password: string | undefined, jdbcRuntime?: JdbcRuntime): Promise<string> {
  const session = openSession(config, password, jdbcRuntime);
  try {
    return await session.serverVersion();
  } finally {
    await session.close();
  }
}
