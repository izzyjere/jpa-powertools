# JPA Power Tools

Browse your database from VS Code and generate JPA entities and Spring Data repositories from its tables: relationships, composite keys, identity columns and optimistic locking included.

## Features

- **Database explorer**: an activity-bar view with connections → schemas → tables → columns, showing primary keys, foreign keys, types, nullability and comments.
- **Connections that are quick to set up**:
  - Paste any JDBC URL and the form fills itself in.
  - Import `spring.datasource.*` straight from `application*.properties` / `application*.yml`, with profiles and `${ENV:default}` placeholders resolved.
  - **Test Connection** gives plain-language errors, e.g. *"Authentication failed for user "app""* or *"The listener does not know service "XEPDB1""*.
  - Passwords are stored in VS Code Secret Storage (your OS keychain), or you can choose to be asked for them on connect.
- **Entity generation wizard**: pick tables, preview the generated code live, then write the files.
  - Detects your project: source folder, base package (from `@SpringBootApplication`), `jakarta` vs `javax`, Lombok, Spring Data JPA.
  - Foreign keys become `@ManyToOne` / `@OneToOne` (lazily fetched), optionally with the inverse `@OneToMany(mappedBy)` side.
  - Composite primary keys get an `@IdClass` with `equals`/`hashCode`. FK columns that are part of the key stay `@Id` fields with a read-only association.
  - Identity/serial/auto-increment columns get `@GeneratedValue(IDENTITY)`, `version` columns get `@Version`, views get `@Immutable`, and table/column comments become Javadoc.
  - Reserved words and mixed-case identifiers are quoted. Java keywords and name clashes are renamed safely.
  - Warns when selected tables reference tables you didn't select, and offers to add them.
  - Existing files are never silently overwritten: you choose **Overwrite** or **Skip Existing**.

## Supported databases

| Database | Driver | Setup |
| --- | --- | --- |
| PostgreSQL, MySQL, MariaDB, SQL Server, Oracle | Built-in (pure JavaScript) | None |
| IBM Db2, H2, HSQLDB, Apache Derby, SQLite, Firebird | JDBC | Java 11+. The JDBC driver is downloaded from Maven Central on first connect (you're asked first, and the checksum is verified) |
| Anything else with a JDBC driver (Informix, SAP HANA, Snowflake, …) | JDBC | Java 11+ and the driver jar |

JDBC databases are read through a small bundled Java helper ([resources/jdbc/JdbcBridge.java](resources/jdbc/JdbcBridge.java)) that uses only `java.sql.DatabaseMetaData`; it never runs SQL. Java is found via the `jpaPowertools.javaHome` setting, then `JAVA_HOME`, then `PATH`.

Generated mappings are tested against real PostgreSQL 16, MySQL 8.4, MariaDB 11.4, SQL Server 2022, Oracle 23 Free and Db2 11.5 databases. The tests compile the code and boot Hibernate 6 with `hbm2ddl.auto=validate`, so the Java types match the actual columns (see [Testing](#testing)).

## Getting started

1. Open the **JPA Power Tools** view in the activity bar.
2. Click **Add Connection** (or **Import from Spring Config**), then **Test Connection** and **Save**.
3. Right-click a connection, schema or table (or select several tables) → **Generate JPA Entities…**
4. Check the preview, adjust packages and options, and click **Generate**.

## Type mapping notes

- Columns map to wrapper types (`Long`, `Integer`, `Boolean`, …) so `NULL` is representable. Timestamps use `java.time` (`LocalDateTime`, `OffsetDateTime` for time-zone-aware columns).
- Oracle `NUMBER(p,0)` maps to `Boolean` (p = 1), `Integer` (p ≤ 9), `Long` (p ≤ 19) or `BigInteger`; other `NUMBER`s map to `BigDecimal`. Oracle `DATE` maps to `LocalDateTime` because it stores a time too.
- `CHAR(n)` columns get `@JdbcTypeCode(SqlTypes.CHAR)` with jakarta/Hibernate 6, or a `columnDefinition` with javax, so schema validation passes.
- JSON columns map to `String` with `@JdbcTypeCode(SqlTypes.JSON)` (Hibernate 6).
- MySQL `ENUM`/`SET`, `TEXT`/`BLOB` variants and widened unsigned integers carry an exact `columnDefinition`. `BIGINT UNSIGNED` maps to `Long`.
- Types with no standard mapping (e.g. PostgreSQL enums, geometry) become `String`/`byte[]` with a `// TODO` comment so you can add a converter.

## Settings

| Setting | Description |
| --- | --- |
| `jpaPowertools.javaHome` | Java 11+ installation used for JDBC-based databases. Defaults to `JAVA_HOME`, then `java` on the `PATH`. |

## Development

```bash
npm install
npm run compile        # or: npm run watch
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host.

### Testing

| Command | What it runs |
| --- | --- |
| `npm run test:unit` | Fast unit tests for naming, type mapping, the generator, URL parsing, Spring config parsing, introspection row mapping and form validation. No database needed. |
| `npm test` | Integration tests inside a real VS Code instance, using the Spring Boot fixture workspace in `src/test/fixtures/spring-app`. The database part runs when PostgreSQL is reachable on port 55432. Set `JPT_SCREENSHOT_DIR` to capture screenshots of the UI (Windows). |
| `npm run test:db` | Connects to each database, checks introspection, then compiles the generated code and validates it with Hibernate 6. Each database is skipped when it isn't reachable. |

To run the database tests locally:

```bash
# Start the databases (ports match src/test/db/dialects.test.ts)
docker run -d --name jpt-pg -e POSTGRES_PASSWORD=secret -e POSTGRES_DB=shop -p 55432:5432 postgres:16-alpine
docker run -d --name jpt-mysql -e MYSQL_ROOT_PASSWORD=secret -e MYSQL_DATABASE=shop -p 53306:3306 mysql:8.4
docker run -d --name jpt-maria -e MARIADB_ROOT_PASSWORD=secret -e MARIADB_DATABASE=shop -p 53307:3306 mariadb:11.4
docker run -d --name jpt-mssql -e ACCEPT_EULA=Y -e 'MSSQL_SA_PASSWORD=Secret#2026' -p 51433:1433 mcr.microsoft.com/mssql/server:2022-latest
docker run -d --name jpt-oracle -e ORACLE_PASSWORD=secret -e APP_USER=shop -e APP_USER_PASSWORD=secret -p 51521:1521 gvenzl/oracle-free:23-slim-faststart
docker run -d --name jpt-db2 --privileged -e LICENSE=accept -e DB2INST1_PASSWORD=secret -e DBNAME=SHOP -p 55000:50000 icr.io/db2_community/db2:11.5.9.0

# Load the fixture schemas from test-db/*.sql into each database, then:
npm run test:libs      # downloads Hibernate, Spring Data, Lombok and JDBC drivers into test-db/lib
npm run test:db
```

`test-db/webview-harness.html` previews the webviews in a normal browser, with VS Code theme variables and a mock extension host (instructions are in the file).

## Roadmap

These items from the original proposal aren't built yet:

- JPQL query generation and validation
- Migration script generation (Flyway/Liquibase)
- Entity-to-table drift checks for existing entity classes
- Generating Java `enum`s from database enum types
