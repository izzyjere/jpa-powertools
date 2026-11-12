# JPA Power Tools

Browse your database from VS Code, generate JPA entities and Spring Data repositories from its tables, and write JPQL with validation, completion and navigation against your entity model.

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

### JPQL support

Works in `@Query` (Spring Data JPA; native queries are skipped), `@NamedQuery` and `entityManager.createQuery(…)`. It handles string concatenation and text blocks. The checks use the `@Entity`, `@Embeddable` and `@MappedSuperclass` classes in your workspace, including inherited attributes and custom `@Entity(name = …)` names.

- **Validation as you type**:
  - Unknown entities, attributes and aliases, with *did you mean* quick fixes (`c.emial` → `c.email`).
  - Navigating into basic attributes or through collections without a join.
  - Syntax slips: `ORDER` without `BY`, a dangling `WHERE`, unclosed strings or parentheses, mixed `:named`/`?1` parameters.
  - Parameter binding, as Spring Data does it: `:name` with no matching `@Param`, and method parameters the query never uses (Spring fails at startup on these).
- **Completion** for entity names, `alias.attribute.paths`, keywords, functions and method parameters.
- **Hover and Ctrl+Click** from any path in a query to the entity field it refers to.
- **Convert to @Query**: a refactoring on Spring Data derived methods. `findByCustomerEmailAndStatusOrderByPlacedAtDesc(…)` becomes an explicit, equivalent JPQL query with `@Param` annotations and imports. `LIKE` variants keep Spring's wildcard escaping. Conversions that would change behaviour (`Top`/`First`, derived deletes, DTO projections) are shown disabled with the reason.
- **Generate JPQL Query…** (editor context menu / Command Palette): pick an entity, filters, fetch joins and ordering. Inside a repository interface it adds a complete `@Query` method; elsewhere it inserts the query string.

The analyzer only reports what it is sure about, so valid HQL extensions (functions, enum literals, implicit aliases, `extract(… from …)`) never show false errors. It is tested against Hibernate 6's own query translator: every query Hibernate accepts in the test corpus passes cleanly, and every generated query is valid for Hibernate. Turn it off with `jpaPowertools.jpql.validation`.

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
| `jpaPowertools.jpql.validation` | Check JPQL in Java files against the workspace's entities (default `true`). |

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
| `npm run test:db` | Connects to each database, checks introspection, then compiles the generated code and validates it with Hibernate 6. Also cross-checks the JPQL analyzer, derived-query conversions and the query builder against Hibernate's HQL translator. Each database is skipped when it isn't reachable. |

To run the database tests locally (Docker and Java 11+ required):

```bash
npm run test:dbs:up        # starts and seeds PostgreSQL, MySQL, MariaDB, SQL Server and Oracle
                           # (bash scripts/test-dbs.sh up db2   adds IBM Db2, which takes ~10 minutes)
npm run test:libs          # downloads Hibernate, Spring Data, Lombok and JDBC drivers into test-db/lib
npm run test:db
npm run test:dbs:down
```

`test-db/webview-harness.html` previews the webviews in a normal browser, with VS Code theme variables and a mock extension host (instructions are in the file).

## Continuous integration and releases

- **CI** ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs on every push and pull request:
  - Lint, unit tests and the VS Code integration tests on Linux, Windows and macOS.
  - A database job that starts PostgreSQL, MySQL, MariaDB, SQL Server and Oracle, then runs the cross-database and Hibernate checks. Db2 is added on the weekly scheduled run, or on request through *Run workflow*.
  - Builds the `.vsix` as a downloadable artifact.
- **Releases** ([.github/workflows/release.yml](.github/workflows/release.yml)) publish to the Visual Studio Marketplace when a version tag is pushed:
  1. Bump `version` in `package.json` and add a `## <version>` section to `CHANGELOG.md`.
  2. `git tag v<version> && git push origin v<version>`
  3. The workflow checks that the tag matches `package.json`, runs the tests, publishes to the Marketplace (and to Open VSX when `OVSX_PAT` is set), and creates a GitHub release with the `.vsix` and the changelog notes.

  One-time setup: create the `izzyjere` publisher on the [Marketplace](https://marketplace.visualstudio.com/manage), then add a `marketplace` environment in the repository settings with a `VSCE_PAT` secret: an Azure DevOps personal access token with the **Marketplace → Manage** scope and *All accessible organizations*. `OVSX_PAT` (an [Open VSX](https://open-vsx.org) token) is optional. Adding required reviewers to the environment gives you a manual approval step before anything is published. Run the workflow manually with *dry run* to build and test a release package without publishing.

## Roadmap

These items from the original proposal aren't built yet:

- Migration script generation (Flyway/Liquibase)
- Entity-to-table drift checks for existing entity classes
- Generating Java `enum`s from database enum types
