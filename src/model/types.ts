/**
 * Core domain model shared by the database layer, the code generators and the UI.
 * This module must stay free of `vscode` imports so it can be unit-tested in plain Node.
 */

export type DbKind =
  | 'postgresql' | 'mysql' | 'mariadb' | 'sqlserver' | 'oracle'
  | 'db2' | 'h2' | 'hsqldb' | 'derby' | 'sqlite' | 'firebird' | 'jdbc';

/** How identifiers are folded by the database when unquoted. Drives quoting in generated mappings. */
export type IdentifierCase = 'lower' | 'upper' | 'insensitive';

export interface MavenArtifact {
  group: string;
  artifact: string;
  version: string;
}

export interface DbDialect {
  kind: DbKind;
  label: string;
  /** 0 for file-based databases. */
  defaultPort: number;
  /** `native`: pure-JS Node driver. `jdbc`: Java bridge with a JDBC driver. */
  driver: 'native' | 'jdbc';
  /** What the user is asked for: a host/port server, a database file, or only a raw JDBC URL. */
  target: 'server' | 'file' | 'url';
  identifierCase: IdentifierCase;
  /** Label of the "database" field (e.g. "Service name" for Oracle). */
  databaseLabel: string;
  databaseRequired: boolean;
  databaseHint?: string;
  defaultUser?: string;
  /** JDBC driver used by the Java bridge (jdbc dialects only). */
  jdbcDriverClass?: string;
  /** Maven Central artifacts making up the JDBC driver (jdbc dialects only). */
  jdbcArtifacts?: MavenArtifact[];
}

export const DIALECTS: readonly DbDialect[] = [
  {
    kind: 'postgresql', label: 'PostgreSQL', defaultPort: 5432, driver: 'native', target: 'server', identifierCase: 'lower',
    databaseLabel: 'Database', databaseRequired: true, defaultUser: 'postgres',
  },
  {
    kind: 'mysql', label: 'MySQL', defaultPort: 3306, driver: 'native', target: 'server', identifierCase: 'insensitive',
    databaseLabel: 'Database', databaseRequired: false, databaseHint: 'Optional: leave empty to browse every database', defaultUser: 'root',
  },
  {
    kind: 'mariadb', label: 'MariaDB', defaultPort: 3306, driver: 'native', target: 'server', identifierCase: 'insensitive',
    databaseLabel: 'Database', databaseRequired: false, databaseHint: 'Optional: leave empty to browse every database', defaultUser: 'root',
  },
  {
    kind: 'sqlserver', label: 'SQL Server', defaultPort: 1433, driver: 'native', target: 'server', identifierCase: 'insensitive',
    databaseLabel: 'Database', databaseRequired: false, databaseHint: 'Optional: defaults to the login\'s default database. Use host\\INSTANCE for named instances', defaultUser: 'sa',
  },
  {
    kind: 'oracle', label: 'Oracle', defaultPort: 1521, driver: 'native', target: 'server', identifierCase: 'upper',
    databaseLabel: 'Service name', databaseRequired: true, databaseHint: 'e.g. FREEPDB1, XEPDB1 or ORCLPDB1',
  },
  {
    kind: 'db2', label: 'IBM Db2', defaultPort: 50000, driver: 'jdbc', target: 'server', identifierCase: 'upper',
    databaseLabel: 'Database', databaseRequired: true, defaultUser: 'db2inst1',
    jdbcDriverClass: 'com.ibm.db2.jcc.DB2Driver',
    jdbcArtifacts: [{ group: 'com.ibm.db2', artifact: 'jcc', version: '11.5.9.0' }],
  },
  {
    kind: 'h2', label: 'H2', defaultPort: 9092, driver: 'jdbc', target: 'url', identifierCase: 'upper',
    databaseLabel: 'Database', databaseRequired: false, defaultUser: 'sa',
    jdbcDriverClass: 'org.h2.Driver',
    jdbcArtifacts: [{ group: 'com.h2database', artifact: 'h2', version: '2.2.224' }],
  },
  {
    kind: 'hsqldb', label: 'HSQLDB', defaultPort: 9001, driver: 'jdbc', target: 'url', identifierCase: 'upper',
    databaseLabel: 'Database', databaseRequired: false, defaultUser: 'SA',
    jdbcDriverClass: 'org.hsqldb.jdbc.JDBCDriver',
    jdbcArtifacts: [{ group: 'org.hsqldb', artifact: 'hsqldb', version: '2.7.2' }],
  },
  {
    kind: 'derby', label: 'Apache Derby', defaultPort: 1527, driver: 'jdbc', target: 'server', identifierCase: 'upper',
    databaseLabel: 'Database', databaseRequired: true, defaultUser: 'app',
    jdbcDriverClass: 'org.apache.derby.client.ClientAutoloadedDriver',
    jdbcArtifacts: [
      { group: 'org.apache.derby', artifact: 'derbyclient', version: '10.16.1.1' },
      { group: 'org.apache.derby', artifact: 'derbyshared', version: '10.16.1.1' },
    ],
  },
  {
    kind: 'sqlite', label: 'SQLite', defaultPort: 0, driver: 'jdbc', target: 'file', identifierCase: 'insensitive',
    databaseLabel: 'Database file', databaseRequired: true,
    jdbcDriverClass: 'org.sqlite.JDBC',
    jdbcArtifacts: [
      { group: 'org.xerial', artifact: 'sqlite-jdbc', version: '3.46.1.3' },
      { group: 'org.slf4j', artifact: 'slf4j-api', version: '1.7.36' },
    ],
  },
  {
    kind: 'firebird', label: 'Firebird', defaultPort: 3050, driver: 'jdbc', target: 'server', identifierCase: 'upper',
    databaseLabel: 'Database (path or alias)', databaseRequired: true, defaultUser: 'SYSDBA',
    jdbcDriverClass: 'org.firebirdsql.jdbc.FBDriver',
    jdbcArtifacts: [{ group: 'org.firebirdsql.jdbc', artifact: 'jaybird', version: '5.0.5.java11' }],
  },
  {
    kind: 'jdbc', label: 'Other (JDBC)', defaultPort: 0, driver: 'jdbc', target: 'url', identifierCase: 'insensitive',
    databaseLabel: 'Database', databaseRequired: false,
  },
];

export function dialect(kind: DbKind): DbDialect {
  return DIALECTS.find(d => d.kind === kind) ?? DIALECTS[DIALECTS.length - 1];
}

export function dbKindLabel(kind: DbKind): string {
  return dialect(kind).label;
}

export function defaultPort(kind: DbKind): number {
  return dialect(kind).defaultPort;
}

/** Persisted connection settings. The password lives in SecretStorage, never here. */
export interface ConnectionConfig {
  id: string;
  name: string;
  kind: DbKind;
  host: string;
  port: number;
  /** Database / service name / file path, depending on the dialect. */
  database: string;
  user: string;
  ssl: boolean;
  /** When false the user is prompted for the password on connect. */
  savePassword: boolean;
  /** JDBC dialects: explicit JDBC URL; overrides host/port/database when set. */
  jdbcUrl?: string;
  /** JDBC dialects: user-supplied driver jars (replace the auto-downloaded driver). */
  driverJars?: string[];
  /** Generic JDBC: driver class name (optional when the jar registers itself via ServiceLoader). */
  driverClass?: string;
}

export interface ColumnInfo {
  name: string;
  /**
   * Normalized, lower-case base type name used for Java type mapping,
   * e.g. `int4`, `varchar`, `timestamptz`, `_text` (PostgreSQL arrays keep the `_` prefix), `number`.
   */
  dataType: string;
  /** Full type as reported by the database, for display, e.g. `character varying(255)` or `int unsigned`. */
  displayType: string;
  /** `java.sql.Types` code, when the column came from JDBC metadata. */
  jdbcType?: number | null;
  length: number | null;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  autoIncrement: boolean;
  unsigned: boolean;
  defaultValue: string | null;
  comment: string | null;
}

export interface KeyInfo {
  name: string;
  columns: string[];
}

export interface ForeignKeyInfo extends KeyInfo {
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string[];
}

export interface TableInfo {
  schema: string;
  name: string;
  kind: 'table' | 'view';
  comment: string | null;
  columns: ColumnInfo[];
  primaryKey: string[];
  foreignKeys: ForeignKeyInfo[];
  uniqueKeys: KeyInfo[];
}

export interface TableSummary {
  schema: string;
  name: string;
  kind: 'table' | 'view';
  comment: string | null;
}

export function tableKey(schema: string, name: string): string {
  return `${schema}.${name}`;
}

/** A flattened key-column row; rows of one constraint must be consecutive and ordered by position. */
export interface ConstraintRow {
  table: string;
  type: 'p' | 'u' | 'f';
  name: string;
  column: string;
  refSchema?: string | null;
  refTable?: string | null;
  refColumn?: string | null;
}

/** Builds full table metadata from summaries, per-table columns and flattened constraint rows. */
export function assembleTables(
  summaries: TableSummary[],
  columns: Array<{ table: string; column: ColumnInfo }>,
  constraints: ConstraintRow[],
): TableInfo[] {
  const tables = new Map<string, TableInfo>();
  for (const s of summaries) {
    tables.set(s.name, { ...s, columns: [], primaryKey: [], foreignKeys: [], uniqueKeys: [] });
  }
  for (const c of columns) {
    tables.get(c.table)?.columns.push(c.column);
  }
  for (const r of constraints) {
    const t = tables.get(r.table);
    if (!t) {
      continue;
    }
    if (r.type === 'p') {
      if (!t.primaryKey.includes(r.column)) {
        t.primaryKey.push(r.column);
      }
    } else if (r.type === 'u') {
      let uk = t.uniqueKeys.find(k => k.name === r.name);
      if (!uk) {
        uk = { name: r.name, columns: [] };
        t.uniqueKeys.push(uk);
      }
      uk.columns.push(r.column);
    } else {
      let fk = t.foreignKeys.find(k => k.name === r.name);
      if (!fk) {
        fk = { name: r.name, columns: [], referencedSchema: r.refSchema ?? t.schema, referencedTable: r.refTable ?? '', referencedColumns: [] };
        t.foreignKeys.push(fk);
      }
      fk.columns.push(r.column);
      fk.referencedColumns.push(r.refColumn ?? '');
    }
  }
  for (const t of tables.values()) {
    // Primary key columns are NOT NULL by definition, even where a driver says otherwise (SQLite).
    for (const col of t.columns) {
      if (t.primaryKey.includes(col.name)) {
        col.nullable = false;
      }
    }
    // A unique key identical to the primary key adds nothing.
    t.uniqueKeys = t.uniqueKeys.filter(k => !(k.columns.length === t.primaryKey.length && k.columns.every(c => t.primaryKey.includes(c))));
  }
  return [...tables.values()];
}
