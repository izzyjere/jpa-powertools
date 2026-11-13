# Change Log

## 1.1.0

- **ER diagrams** (`*.erd.json`):
  - Create from `@Entity` classes, from database tables, or from scratch.
  - Two views: entities and tables.
  - Crow's-foot relationships, drag and auto layout, an inspector to edit tables, columns and relationships, search, and SVG/PNG export.
- Generate **JPA entities** (through the generator wizard) and **SQL DDL** for any supported database from a diagram, including the next Flyway migration.
- **Sync** a diagram with its entities or database while keeping its layout.
- Oracle `NUMBER(10)` now maps to `Integer`, matching Hibernate's own convention.
- Releases publish to the Marketplace with Trusted Publishing (GitHub OIDC) instead of a personal access token.

## 1.0.0

First stable release on the Visual Studio Marketplace.

- Released under the MIT license.
- A 1:30 demo video in the README showing connections, entity generation and JPQL support.
- CI now runs on Node 22 and the VS Code integration tests launch on macOS again (VS Code 1.110+ renamed the macOS executable).

## 0.2.0

- JPQL support in `@Query`, `@NamedQuery` and `createQuery(…)`:
  - Validation against the workspace's entities, with "did you mean" quick fixes.
  - `@Param` binding checks, completion, hover and go-to-definition.
- **Convert to @Query** refactoring for Spring Data derived query methods.
- **Generate JPQL Query…** builder that adds a complete `@Query` repository method.
- Database drivers load on first connection, so opening Java files stays fast.
- CI on Linux, Windows and macOS with real databases, and tag-based publishing to the Visual Studio Marketplace and Open VSX.

## 0.1.0

First working release.

- Database explorer view: connections, schemas, tables and columns, with key and type details.
- Connection form with JDBC URL paste, Spring `application.properties`/`.yml` import, Test Connection and passwords in Secret Storage.
- Built-in drivers for PostgreSQL, MySQL, MariaDB, SQL Server and Oracle. JDBC bridge (Java 11+) for Db2, H2, HSQLDB, Derby, SQLite, Firebird and any JDBC driver, with checksum-verified driver downloads.
- Entity generation wizard with live preview: associations from foreign keys, composite keys via `@IdClass`, identity columns, `@Version`, Lombok, jakarta/javax, Spring Data repositories, and project auto-detection.
