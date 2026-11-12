import { ConnectionConfig, dialect } from '../model/types';
import { JdbcSession } from './jdbc/jdbcSession';
import { JdbcRuntime } from './jdbc/runtime';
import { MysqlSession } from './mysql';
import { OracleSession } from './oracle';
import { PostgresSession } from './postgres';
import { DbSession } from './session';
import { SqlServerSession } from './sqlserver';

/**
 * Creates a session for the connection. JDBC-backed dialects need a `jdbcRuntime`
 * (Java executable + driver jars); native dialects ignore it.
 */
export function openSession(config: ConnectionConfig, password: string | undefined, jdbcRuntime?: JdbcRuntime): DbSession {
  switch (config.kind) {
    case 'postgresql':
      return new PostgresSession(config, password);
    case 'mysql':
    case 'mariadb':
      return new MysqlSession(config, password);
    case 'sqlserver':
      return new SqlServerSession(config, password);
    case 'oracle':
      return new OracleSession(config, password);
    default:
      if (dialect(config.kind).driver !== 'jdbc') {
        throw new Error(`Unsupported database type: ${config.kind}`);
      }
      if (!jdbcRuntime) {
        throw new Error(`${dialect(config.kind).label} connections need the JDBC runtime.`);
      }
      return new JdbcSession(config, password, jdbcRuntime);
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
