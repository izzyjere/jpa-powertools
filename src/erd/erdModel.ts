/**
 * The ER diagram document (`*.erd.json`) and its conversions:
 *   database tables ⇄ diagram ⇄ JPA entities, diagram → SQL DDL (see ddl.ts).
 * Column types are stored as portable ERD types and mapped to each database on output.
 * Pure module: no `vscode` imports.
 */
import { columnToFieldName, tableToClassName, toPascalCase } from '../codegen/naming';
import { mapColumnType } from '../codegen/typeMapping';
import { EntityModel, ModelAttribute, ModelClass } from '../jpql/entityModel';
import { nestedNames } from '../jpql/javaSource';
import { ColumnInfo, DbKind, dialect, ForeignKeyInfo, KeyInfo, TableInfo, tableKey } from '../model/types';

export const ERD_TYPES = [
  'BIGINT', 'INTEGER', 'SMALLINT', 'DECIMAL', 'DOUBLE', 'REAL', 'BOOLEAN', 'VARCHAR', 'CHAR', 'TEXT',
  'DATE', 'TIME', 'TIMESTAMP', 'TIMESTAMPTZ', 'UUID', 'BINARY', 'BLOB', 'JSON',
] as const;
export type ErdType = typeof ERD_TYPES[number];

export interface ErdColumn {
  name: string;
  /** Java field name (logical view); derived from the column name when absent. */
  field?: string;
  type: ErdType;
  length?: number;
  precision?: number;
  scale?: number;
  nullable: boolean;
  primaryKey: boolean;
  autoIncrement: boolean;
  unique: boolean;
  comment?: string;
  /** Exact type in the source database (used when generating DDL for that same database). */
  nativeType?: string;
}

export interface ErdEntity {
  /** Stable id: `schema.table` when imported. */
  id: string;
  table: string;
  schema?: string;
  /** Java class name (logical view); derived from the table name when absent. */
  className?: string;
  kind: 'table' | 'view';
  comment?: string;
  columns: ErdColumn[];
  /** Canvas position; absent means "place me" (auto layout). */
  x?: number;
  y?: number;
  /** Header accent, one of ERD_COLORS. */
  color?: string;
}

export interface ErdRelationship {
  id: string;
  /** Entity holding the foreign key. */
  from: string;
  columns: string[];
  /** Referenced entity. */
  to: string;
  refColumns: string[];
  /** The foreign key is unique (one-to-one). */
  oneToOne?: boolean;
  /** Association field on the `from` entity, e.g. `customer`. */
  field?: string;
  /** Inverse collection/field on the `to` entity, e.g. `orders`. */
  inverseField?: string;
  /** Constraint name. */
  name?: string;
}

export interface ErdDocument {
  version: 1;
  name: string;
  /** Database the diagram targets (types, identifier case, DDL). */
  dialect: DbKind;
  /** Database that `nativeType`s come from, if any. */
  nativeDialect?: DbKind;
  source?: { type: 'entities' } | { type: 'database'; connectionId: string; connection: string; schema: string };
  entities: ErdEntity[];
  relationships: ErdRelationship[];
}

export const ERD_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b'];

export function emptyDocument(name: string, dialectKind: DbKind = 'postgresql'): ErdDocument {
  return { version: 1, name, dialect: dialectKind, entities: [], relationships: [] };
}

// ---------------------------------------------------------------------------------------------- types

/** Portable type for a column read from a database. */
export function erdTypeFromColumn(col: ColumnInfo, kind: DbKind): Pick<ErdColumn, 'type' | 'length' | 'precision' | 'scale'> {
  const m = mapColumnType(col, kind);
  const len = col.length ?? undefined;
  switch (m.javaType) {
    case 'Long': case 'BigInteger': return { type: 'BIGINT' };
    case 'Integer': return { type: 'INTEGER' };
    case 'Short': case 'Byte': return { type: 'SMALLINT' };
    case 'BigDecimal': return { type: 'DECIMAL', precision: col.precision ?? undefined, scale: col.scale ?? undefined };
    case 'Double': return { type: 'DOUBLE' };
    case 'Float': return { type: 'REAL' };
    case 'Boolean': return { type: 'BOOLEAN' };
    case 'LocalDate': return { type: 'DATE' };
    case 'LocalTime': case 'OffsetTime': return { type: 'TIME' };
    case 'LocalDateTime': return { type: 'TIMESTAMP' };
    case 'OffsetDateTime': case 'Instant': return { type: 'TIMESTAMPTZ' };
    case 'UUID': return { type: 'UUID' };
    case 'byte[]': return len && !m.lob ? { type: 'BINARY', length: len } : { type: 'BLOB' };
    case 'String':
      if (m.json) {
        return { type: 'JSON' };
      }
      if (m.fixedChar) {
        return { type: 'CHAR', length: len };
      }
      return len && !m.lob ? { type: 'VARCHAR', length: len } : { type: 'TEXT' };
    default:
      return { type: 'TEXT' };
  }
}

/** Portable type for a Java attribute (entity → diagram). */
export function erdTypeFromJava(attr: ModelAttribute, isEnum = false): Pick<ErdColumn, 'type' | 'length' | 'precision' | 'scale'> {
  const col = attr.annotations?.Column ?? {};
  const length = col.length ? Number(col.length) : undefined;
  const lob = !!attr.annotations?.Lob;
  const jdbcType = attr.annotations?.JdbcTypeCode?.value ?? '';
  switch (attr.elementType) {
    case 'Long': case 'long': return { type: 'BIGINT' };
    case 'Integer': case 'int': return { type: 'INTEGER' };
    case 'Short': case 'short': case 'Byte': case 'byte':
      return attr.type.includes('[]') ? (lob ? { type: 'BLOB' } : { type: 'BINARY', length: length ?? 255 }) : { type: 'SMALLINT' };
    case 'Boolean': case 'boolean': return { type: 'BOOLEAN' };
    case 'BigDecimal': return { type: 'DECIMAL', precision: col.precision ? Number(col.precision) : 38, scale: col.scale ? Number(col.scale) : 2 };
    case 'BigInteger': return { type: 'DECIMAL', precision: col.precision ? Number(col.precision) : 38, scale: 0 };
    case 'Double': case 'double': return { type: 'DOUBLE' };
    case 'Float': case 'float': return { type: 'REAL' };
    case 'LocalDate': return { type: 'DATE' };
    case 'LocalTime': case 'OffsetTime': return { type: 'TIME' };
    case 'LocalDateTime': case 'Date': case 'Timestamp': case 'Calendar': return { type: 'TIMESTAMP' };
    case 'Instant': case 'OffsetDateTime': case 'ZonedDateTime': return { type: 'TIMESTAMPTZ' };
    case 'UUID': return { type: 'UUID' };
    case 'Duration': return { type: 'BIGINT' };
    case 'Character': case 'char': return { type: 'CHAR', length: 1 };
    case 'String':
      if (/JSON/.test(jdbcType)) {
        return { type: 'JSON' };
      }
      if (/CHAR/.test(jdbcType) && !/VARCHAR/.test(jdbcType)) {
        return { type: 'CHAR', length: length ?? 1 };
      }
      return lob ? { type: 'TEXT' } : { type: 'VARCHAR', length: length ?? 255 };
  }
  if (attr.annotations?.Enumerated || isEnum) {
    // JPA stores enums by ordinal unless @Enumerated(EnumType.STRING)
    return /STRING/.test(attr.annotations?.Enumerated?.value ?? '') ? { type: 'VARCHAR', length: 255 } : { type: 'SMALLINT' };
  }
  return { type: 'VARCHAR', length: length ?? 255 };
}

/** `java.sql.Types` codes for each ERD type (used by the JDBC type mapping). */
const JDBC_CODES: Record<ErdType, number> = {
  BIGINT: -5, INTEGER: 4, SMALLINT: 5, DECIMAL: 3, DOUBLE: 8, REAL: 7, BOOLEAN: 16, VARCHAR: 12, CHAR: 1, TEXT: 2005,
  DATE: 91, TIME: 92, TIMESTAMP: 93, TIMESTAMPTZ: 2014, UUID: 1111, BINARY: -3, BLOB: 2004, JSON: 1111,
};

/** Native column type for a database, e.g. `VARCHAR` → `varchar2(100 char)` on Oracle. */
export function nativeType(c: Pick<ErdColumn, 'type' | 'length' | 'precision' | 'scale'>, kind: DbKind): string {
  const n = c.length ?? 255;
  const p = c.precision ?? 19;
  const s = c.scale ?? 2;
  const dec = (name: string) => (c.precision ? `${name}(${c.precision},${c.scale ?? 0})` : name === 'number' ? 'number' : `${name}(${p},${s})`);
  const mysql = kind === 'mysql' || kind === 'mariadb';
  switch (c.type) {
    case 'BIGINT': return kind === 'oracle' ? 'number(19)' : kind === 'sqlite' ? 'integer' : 'bigint';
    case 'INTEGER': return kind === 'oracle' ? 'number(10)' : mysql || kind === 'sqlserver' ? 'int' : 'integer';
    case 'SMALLINT': return kind === 'oracle' ? 'number(5)' : 'smallint';
    case 'DECIMAL': return kind === 'oracle' ? dec('number') : kind === 'postgresql' ? dec('numeric') : dec('decimal');
    case 'DOUBLE': return kind === 'postgresql' || kind === 'h2' || kind === 'firebird' ? 'double precision'
      : kind === 'sqlserver' || kind === 'oracle' ? 'float' : kind === 'sqlite' ? 'real' : 'double';
    case 'REAL': return kind === 'oracle' ? 'binary_float' : mysql ? 'float' : 'real';
    case 'BOOLEAN': return kind === 'oracle' ? 'number(1)' : kind === 'sqlserver' ? 'bit' : 'boolean';
    case 'VARCHAR': return kind === 'oracle' ? `varchar2(${n} char)` : `varchar(${n})`;
    case 'CHAR': return kind === 'oracle' ? `char(${c.length ?? 1} char)` : `char(${c.length ?? 1})`;
    case 'TEXT': return kind === 'oracle' || kind === 'db2' || kind === 'derby' || kind === 'hsqldb' ? 'clob'
      : kind === 'sqlserver' ? 'nvarchar(max)' : mysql ? 'longtext' : kind === 'h2' ? 'character large object'
        : kind === 'firebird' ? 'blob sub_type text' : 'text';
    case 'DATE': return 'date';
    case 'TIME': return kind === 'oracle' ? 'timestamp' : 'time';
    case 'TIMESTAMP': return mysql ? 'datetime(6)' : kind === 'sqlserver' ? 'datetime2' : 'timestamp';
    case 'TIMESTAMPTZ': return kind === 'postgresql' || kind === 'oracle' || kind === 'h2' || kind === 'hsqldb' || kind === 'firebird'
      ? 'timestamp with time zone' : kind === 'sqlserver' ? 'datetimeoffset' : mysql ? 'datetime(6)' : 'timestamp';
    case 'UUID': return kind === 'postgresql' || kind === 'h2' || kind === 'hsqldb' ? 'uuid' : kind === 'sqlserver' ? 'uniqueidentifier'
      : kind === 'oracle' ? 'raw(16)' : kind === 'mariadb' ? 'uuid' : 'char(36)';
    case 'BINARY': return kind === 'postgresql' ? 'bytea' : kind === 'oracle' ? `raw(${Math.min(n, 2000)})` : kind === 'sqlite' ? 'blob' : `varbinary(${n})`;
    case 'BLOB': return kind === 'postgresql' ? 'bytea' : mysql ? 'longblob' : kind === 'sqlserver' ? 'varbinary(max)' : 'blob';
    case 'JSON': return kind === 'postgresql' ? 'jsonb' : mysql || kind === 'h2' ? 'json' : kind === 'sqlserver' ? 'nvarchar(max)'
      : kind === 'oracle' ? 'json' : kind === 'firebird' ? 'blob sub_type text' : kind === 'sqlite' ? 'text' : 'clob';
  }
}

/** Column metadata in the shape introspection produces, for feeding the entity generator. */
export function columnInfo(c: ErdColumn, kind: DbKind, nativeOverride?: string): ColumnInfo {
  const display = nativeOverride ?? nativeType(c, kind);
  const base = display.toLowerCase().replace(/\(.*$/, '').replace(/\s+(char|byte)\)?$/, '').trim();
  const pgBase: Record<string, string> = { 'double precision': 'float8', real: 'float4', 'timestamp with time zone': 'timestamptz', integer: 'int4', bigint: 'int8', smallint: 'int2', boolean: 'bool', char: 'bpchar' };
  const dataType = kind === 'postgresql' ? (pgBase[base] ?? base) : base;
  const lengthTypes = c.type === 'VARCHAR' || c.type === 'CHAR' || c.type === 'BINARY';
  const lengthFromNative = /\((\d+)/.exec(display)?.[1];
  let length: number | null = lengthTypes ? (c.length ?? (lengthFromNative ? Number(lengthFromNative) : null)) : null;
  if ((kind === 'mysql' || kind === 'mariadb') && c.type === 'BOOLEAN') {
    length = 1; // tinyint(1)
  }
  const oracleNumber = kind === 'oracle' && dataType === 'number';
  const numberPrecision = oracleNumber ? Number(/number\((\d+)/.exec(display)?.[1] ?? NaN) : NaN;
  return {
    name: c.name,
    dataType: (kind === 'mysql' || kind === 'mariadb') && c.type === 'BOOLEAN' ? 'tinyint' : dataType,
    displayType: display,
    jdbcType: JDBC_CODES[c.type],
    length,
    precision: c.type === 'DECIMAL' ? (c.precision ?? null) : oracleNumber && !Number.isNaN(numberPrecision) ? numberPrecision : null,
    scale: c.type === 'DECIMAL' ? (c.scale ?? null) : oracleNumber ? 0 : null,
    nullable: c.nullable && !c.primaryKey,
    autoIncrement: c.autoIncrement,
    unsigned: false,
    defaultValue: null,
    comment: c.comment ?? null,
  };
}

// ---------------------------------------------------------------------------------------------- names

/** How a database stores an unquoted identifier; quoted (special) names are kept as written. */
export function foldIdentifier(name: string, kind: DbKind): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return name;
  }
  const c = dialect(kind).identifierCase;
  return c === 'upper' ? name.toUpperCase() : c === 'lower' ? name.toLowerCase() : name;
}

/** Spring Boot's default physical naming (CamelCaseToUnderscoresNamingStrategy): `fullName` → `full_name`. */
export function snakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').replace(/[.\s-]+/g, '_').toLowerCase();
}

export function entityClassName(e: ErdEntity): string {
  return e.className || tableToClassName(e.table);
}

export function columnFieldName(c: ErdColumn): string {
  return c.field || columnToFieldName(c.name);
}

// ---------------------------------------------------------------------------------------------- database → diagram

export function fromTables(tables: TableInfo[], kind: DbKind, name: string, source?: ErdDocument['source']): ErdDocument {
  const doc: ErdDocument = { version: 1, name, dialect: kind, nativeDialect: kind, source, entities: [], relationships: [] };
  const ids = new Set(tables.map(t => tableKey(t.schema, t.name)));
  for (const t of tables) {
    const single = new Set(t.uniqueKeys.filter(k => k.columns.length === 1).map(k => k.columns[0]));
    doc.entities.push({
      id: tableKey(t.schema, t.name),
      table: t.name,
      schema: t.schema || undefined,
      kind: t.kind,
      comment: t.comment ?? undefined,
      columns: t.columns.map(c => ({
        name: c.name,
        ...erdTypeFromColumn(c, kind),
        nullable: c.nullable,
        primaryKey: t.primaryKey.includes(c.name),
        autoIncrement: c.autoIncrement,
        unique: single.has(c.name) && !t.primaryKey.includes(c.name),
        comment: c.comment ?? undefined,
        nativeType: c.displayType,
      })),
    });
    for (const fk of t.foreignKeys) {
      const to = tableKey(fk.referencedSchema, fk.referencedTable);
      if (!ids.has(to)) {
        continue;
      }
      const oneToOne = t.uniqueKeys.some(k => sameSet(k.columns, fk.columns)) || sameSet(t.primaryKey, fk.columns);
      doc.relationships.push({
        id: `${tableKey(t.schema, t.name)}:${fk.name}`, name: fk.name, from: tableKey(t.schema, t.name), columns: fk.columns,
        to, refColumns: fk.referencedColumns, oneToOne: oneToOne || undefined,
      });
    }
  }
  assignColors(doc);
  return doc;
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length > 0 && a.length === b.length && a.every(x => b.includes(x));
}

/** Gives every entity a header color, grouping entities connected by relationships. */
export function assignColors(doc: ErdDocument): void {
  const parent = new Map(doc.entities.map(e => [e.id, e.id]));
  const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
  for (const r of doc.relationships) {
    if (parent.has(r.from) && parent.has(r.to)) {
      parent.set(find(r.from), find(r.to));
    }
  }
  const groupColor = new Map<string, string>();
  for (const e of doc.entities) {
    if (e.color) {
      continue;
    }
    const g = find(e.id);
    if (!groupColor.has(g)) {
      groupColor.set(g, ERD_COLORS[groupColor.size % ERD_COLORS.length]);
    }
    e.color = groupColor.get(g);
  }
}

// ---------------------------------------------------------------------------------------------- entities → diagram

interface EntityTable {
  cls: ModelClass;
  entity: ErdEntity;
  pk: ErdColumn[];
}

/**
 * Builds a diagram from the workspace's JPA entities, following Spring Boot's default naming
 * (snake_case tables and columns) unless @Table/@Column/@JoinColumn/@JoinTable say otherwise.
 */
export function fromEntityModel(model: EntityModel, name: string, kind: DbKind = 'postgresql'): ErdDocument {
  const doc: ErdDocument = { version: 1, name, dialect: kind, source: { type: 'entities' }, entities: [], relationships: [] };
  const entities = model.entities();
  const byClass = new Map<ModelClass, EntityTable>();
  const isEntity = (c: ModelClass | undefined) => !!c && c.kind === 'entity';

  // Inheritance: SINGLE_TABLE (the JPA default) puts subclasses into the root's table.
  const parentEntity = (c: ModelClass): ModelClass | undefined => {
    for (const a of c.attributes.values()) {
      if (a.owner !== c && isEntity(a.owner)) {
        return a.owner;
      }
    }
    return undefined;
  };
  const rootOf = (c: ModelClass): ModelClass => {
    let cur = c;
    for (let p = parentEntity(cur); p; p = parentEntity(p)) {
      cur = p;
    }
    return cur;
  };
  const strategy = (c: ModelClass) => rootOf(c).annotations.Inheritance?.strategy ?? '';
  const singleTableChild = (c: ModelClass) => parentEntity(c) && !/JOINED|TABLE_PER_CLASS/.test(strategy(c));

  const tableName = (c: ModelClass) => c.annotations.Table?.name || snakeCase(c.entityName ?? c.name);

  // Pass 1: tables with basic columns and primary keys.
  for (const cls of entities) {
    if (singleTableChild(cls)) {
      continue;
    }
    const entity: ErdEntity = {
      id: cls.fqn, table: tableName(cls), schema: cls.annotations.Table?.schema || undefined, className: cls.name, kind: 'table', columns: [],
    };
    if (cls.annotations.Immutable || cls.annotations.Subselect) {
      entity.kind = 'view';
    }
    doc.entities.push(entity);
    byClass.set(cls, { cls, entity, pk: [] });
  }
  // Roots before subclasses, so a single table lists the root's columns first.
  const depth = (c: ModelClass): number => { const p = parentEntity(c); return p ? depth(p) + 1 : 0; };
  for (const cls of [...entities].sort((a, b) => depth(a) - depth(b))) {
    const target = byClass.get(singleTableChild(cls) ? rootOf(cls) : cls);
    if (!target) {
      continue;
    }
    const joined = parentEntity(cls) && /JOINED/.test(strategy(cls));
    for (const a of cls.attributes.values()) {
      // Single-table children add only their own attributes; joined children only their own plus the id.
      if ((singleTableChild(cls) || joined) && a.owner !== cls && !a.annotations?.Id) {
        continue;
      }
      if (singleTableChild(cls) && a.annotations?.Id) {
        continue;
      }
      addBasicColumns(model, target, a, '');
    }
    if (singleTableChild(cls) && !target.entity.columns.some(c => c.name === 'dtype')) {
      const discriminator = rootOf(cls).annotations.DiscriminatorColumn?.name || 'dtype';
      target.entity.columns.push(col(discriminator, { type: 'VARCHAR', length: 31 }, { nullable: false }));
    }
  }
  for (const t of byClass.values()) {
    t.pk = t.entity.columns.filter(c => c.primaryKey);
  }

  // Joined inheritance: the child table's primary key references the parent table.
  for (const cls of entities) {
    const parent = parentEntity(cls);
    const child = byClass.get(cls);
    const parentTable = parent && byClass.get(parent);
    if (child && parentTable && /JOINED/.test(strategy(cls)) && child.pk.length) {
      doc.relationships.push({
        id: `${child.entity.id}.$parent`, from: child.entity.id, columns: child.pk.map(c => c.name), to: parentTable.entity.id,
        refColumns: parentTable.pk.map(c => c.name), oneToOne: true,
      });
    }
  }

  // Pass 2: associations.
  const pending: Array<{ rel: ErdRelationship; mappedBy?: string; owner: ModelClass }> = [];
  for (const cls of entities) {
    const owner = byClass.get(singleTableChild(cls) ? rootOf(cls) : cls);
    if (!owner) {
      continue;
    }
    for (const a of cls.attributes.values()) {
      if (singleTableChild(cls) && a.owner !== cls) {
        continue;
      }
      const targetCls = model.target(a);
      if (!isEntity(targetCls)) {
        if (a.annotations?.ElementCollection) {
          addElementCollection(doc, model, owner, a);
        }
        continue;
      }
      const target = byClass.get(singleTableChild(targetCls!) ? rootOf(targetCls!) : targetCls!);
      if (!target) {
        continue;
      }
      const ann = a.annotations ?? {};
      const mappedBy = ann.OneToMany?.mappedBy || ann.OneToOne?.mappedBy || ann.ManyToMany?.mappedBy;
      if (mappedBy) {
        pending.push({ rel: { id: '', from: target.entity.id, columns: [], to: owner.entity.id, refColumns: [] }, mappedBy, owner: cls });
        continue;
      }
      if (ann.ManyToOne || ann.OneToOne) {
        const names = ann.JoinColumn?.name ? [ann.JoinColumn.name] : nestedNames(ann.JoinColumns?.value);
        const refs = target.pk;
        const columns = refs.map((r, i) => names[i] || `${snakeCase(a.name)}_${r.name}`);
        const optional = !/false/.test(ann.ManyToOne?.optional ?? ann.OneToOne?.optional ?? '') && !/false/.test(ann.JoinColumn?.nullable ?? '');
        columns.forEach((c, i) => {
          if (!owner.entity.columns.some(x => x.name === c)) {
            owner.entity.columns.push(col(c, typeOf(refs[i]), { nullable: optional, unique: !!ann.OneToOne && columns.length === 1 }));
          }
        });
        doc.relationships.push({
          id: `${owner.entity.id}.${a.name}`, from: owner.entity.id, columns, to: target.entity.id, refColumns: refs.map(r => r.name),
          oneToOne: !!ann.OneToOne || undefined, field: a.name,
        });
      } else if (ann.OneToMany && ann.JoinColumn?.name) {
        // Unidirectional one-to-many with a join column: the FK lives on the target table.
        const refs = owner.pk;
        const column = ann.JoinColumn.name;
        if (!target.entity.columns.some(x => x.name === column) && refs[0]) {
          target.entity.columns.push(col(column, typeOf(refs[0]), { nullable: true }));
        }
        doc.relationships.push({
          id: `${owner.entity.id}.${a.name}`, from: target.entity.id, columns: [column], to: owner.entity.id,
          refColumns: refs.slice(0, 1).map(r => r.name), inverseField: a.name,
        });
      } else if (ann.ManyToMany || ann.OneToMany) {
        addJoinTable(doc, owner, target, a, cls);
      }
    }
  }

  // Inverse sides (mappedBy) decorate the owning relationship.
  for (const p of pending) {
    const rel = doc.relationships.find(r => r.from === p.rel.from && r.to === p.rel.to && r.field === p.mappedBy)
      ?? doc.relationships.find(r => r.id.endsWith(`.${p.mappedBy}`) && (r.from === p.rel.from || r.to === p.rel.to));
    const attr = [...p.owner.attributes.values()].find(x => (x.annotations?.OneToMany?.mappedBy ?? x.annotations?.OneToOne?.mappedBy ?? x.annotations?.ManyToMany?.mappedBy) === p.mappedBy);
    if (rel && attr) {
      rel.inverseField = attr.name;
    }
  }
  assignColors(doc);
  return doc;

  function typeOf(c: ErdColumn | undefined): Pick<ErdColumn, 'type' | 'length' | 'precision' | 'scale'> {
    return c ? { type: c.type, length: c.length, precision: c.precision, scale: c.scale } : { type: 'BIGINT' };
  }
}

function col(name: string, type: Pick<ErdColumn, 'type' | 'length' | 'precision' | 'scale'>, opts: Partial<ErdColumn> = {}): ErdColumn {
  return { name, ...type, nullable: true, primaryKey: false, autoIncrement: false, unique: false, ...opts };
}

function addBasicColumns(model: EntityModel, t: EntityTable, a: ModelAttribute, prefix: string): void {
  const target = model.target(a);
  if (target && target.kind === 'entity') {
    return; // associations are handled in pass 2
  }
  if (a.collection) {
    return; // element collections live in their own table
  }
  const ann = a.annotations ?? {};
  if (target && target.kind === 'embeddable') {
    for (const sub of target.attributes.values()) {
      addBasicColumns(model, t, sub, `${prefix}${a.name}.`);
    }
    return;
  }
  const columnName = ann.Column?.name || snakeCase(a.name);
  if (t.entity.columns.some(c => c.name === columnName)) {
    return;
  }
  const primitive = /^(int|long|short|byte|boolean|double|float|char)$/.test(a.elementType);
  const id = !!ann.Id || !!ann.EmbeddedId;
  t.entity.columns.push({
    name: columnName,
    field: prefix ? undefined : a.name,
    ...erdTypeFromJava(a, model.isEnum(a)),
    nullable: !id && !primitive && !/false/.test(ann.Column?.nullable ?? '') && !ann.Version,
    primaryKey: id,
    autoIncrement: id && /IDENTITY/.test(ann.GeneratedValue?.strategy ?? ''),
    unique: /true/.test(ann.Column?.unique ?? ''),
  });
}

function addJoinTable(doc: ErdDocument, owner: EntityTable, target: EntityTable, a: ModelAttribute, ownerCls: ModelClass): void {
  const jt = a.annotations?.JoinTable ?? {};
  const name = jt.name || `${owner.entity.table}_${a.annotations?.ManyToMany ? target.entity.table : snakeCase(a.name)}`;
  const joinNames = nestedNames(jt.joinColumns);
  const inverseNames = nestedNames(jt.inverseJoinColumns);
  const ownerPk = owner.pk[0];
  const targetPk = target.pk[0];
  if (!ownerPk || !targetPk) {
    return;
  }
  const ownerCol = joinNames[0] || `${snakeCase(ownerCls.entityName ?? ownerCls.name)}_${ownerPk.name}`;
  const targetCol = inverseNames[0] || `${snakeCase(a.name)}_${targetPk.name}`;
  const id = `${owner.entity.schema ? `${owner.entity.schema}.` : ''}${name}`;
  if (!doc.entities.some(e => e.id === id)) {
    doc.entities.push({
      id, table: name, schema: owner.entity.schema, kind: 'table',
      className: toPascalCase(name),
      columns: [
        col(ownerCol, { type: ownerPk.type, length: ownerPk.length }, { nullable: false, primaryKey: true }),
        col(targetCol, { type: targetPk.type, length: targetPk.length }, { nullable: false, primaryKey: !!a.annotations?.ManyToMany, unique: !a.annotations?.ManyToMany }),
      ],
    });
  }
  doc.relationships.push(
    { id: `${id}.${ownerCol}`, from: id, columns: [ownerCol], to: owner.entity.id, refColumns: [ownerPk.name], inverseField: a.name },
    { id: `${id}.${targetCol}`, from: id, columns: [targetCol], to: target.entity.id, refColumns: [targetPk.name] },
  );
}

function addElementCollection(doc: ErdDocument, model: EntityModel, owner: EntityTable, a: ModelAttribute): void {
  const ownerPk = owner.pk[0];
  if (!ownerPk) {
    return;
  }
  // Hibernate names collection tables after the owning entity: Product.tags → product_tags
  const name = a.annotations?.CollectionTable?.name || `${snakeCase(owner.cls.entityName ?? owner.cls.name)}_${snakeCase(a.name)}`;
  const id = `${owner.entity.schema ? `${owner.entity.schema}.` : ''}${name}`;
  if (doc.entities.some(e => e.id === id)) {
    return;
  }
  const fk = nestedNames(a.annotations?.CollectionTable?.joinColumns)[0] || `${snakeCase(owner.cls.entityName ?? owner.cls.name)}_${ownerPk.name}`;
  const valueColumn = a.annotations?.Column?.name || snakeCase(a.name);
  const element = model.target(a);
  const columns: ErdColumn[] = [col(fk, { type: ownerPk.type, length: ownerPk.length }, { nullable: false })];
  if (element && element.kind === 'embeddable') {
    for (const sub of element.attributes.values()) {
      columns.push(col(sub.annotations?.Column?.name || snakeCase(sub.name), erdTypeFromJava(sub, model.isEnum(sub))));
    }
  } else {
    columns.push(col(valueColumn, erdTypeFromJava({ ...a, collection: false }, model.isEnum(a))));
  }
  doc.entities.push({ id, table: name, schema: owner.entity.schema, kind: 'table', className: toPascalCase(name), columns });
  doc.relationships.push({ id: `${id}.${fk}`, from: id, columns: [fk], to: owner.entity.id, refColumns: [ownerPk.name], inverseField: a.name });
}

// ---------------------------------------------------------------------------------------------- diagram → tables

/**
 * Converts the diagram into table metadata for the target database (identifiers folded the way the
 * database folds unquoted names), ready for the entity generator and the DDL generator.
 */
export function toTables(doc: ErdDocument, kind: DbKind = doc.dialect): { tables: TableInfo[]; classNames: Record<string, string> } {
  const byId = new Map(doc.entities.map(e => [e.id, e]));
  const fold = (s: string) => foldIdentifier(s, kind);
  const useNative = doc.nativeDialect === kind;
  const classNames: Record<string, string> = {};
  const tables = doc.entities.map<TableInfo>(e => {
    const schema = e.schema ? fold(e.schema) : '';
    const uniques: KeyInfo[] = e.columns.filter(c => c.unique && !c.primaryKey).map(c => ({ name: `uk_${e.table}_${c.name}`, columns: [fold(c.name)] }));
    const fks: ForeignKeyInfo[] = [];
    for (const r of doc.relationships.filter(x => x.from === e.id)) {
      const target = byId.get(r.to);
      if (!target) {
        continue;
      }
      fks.push({
        name: r.name || `fk_${e.table}_${r.columns.join('_')}`.slice(0, 60),
        columns: r.columns.map(fold),
        referencedSchema: target.schema ? fold(target.schema) : '',
        referencedTable: fold(target.table),
        referencedColumns: r.refColumns.map(fold),
      });
      if (r.oneToOne && !uniques.some(u => sameSet(u.columns, r.columns.map(fold))) && !sameSet(e.columns.filter(c => c.primaryKey).map(c => fold(c.name)), r.columns.map(fold))) {
        uniques.push({ name: `uk_${e.table}_${r.columns.join('_')}`.slice(0, 60), columns: r.columns.map(fold) });
      }
    }
    const t: TableInfo = {
      schema,
      name: fold(e.table),
      kind: e.kind,
      comment: e.comment ?? null,
      columns: e.columns.map(c => ({ ...columnInfo(c, kind, useNative ? c.nativeType : undefined), name: fold(c.name) })),
      primaryKey: e.columns.filter(c => c.primaryKey).map(c => fold(c.name)),
      foreignKeys: fks,
      uniqueKeys: uniques,
    };
    if (e.className) {
      classNames[tableKey(t.schema, t.name)] = e.className;
    }
    return t;
  });
  return { tables, classNames };
}

// ---------------------------------------------------------------------------------------------- merging

/** Keeps positions and colors from a previous version of the diagram (matched by id, then table name). */
export function mergeLayout(next: ErdDocument, previous: ErdDocument | undefined): ErdDocument {
  if (!previous) {
    return next;
  }
  const byId = new Map(previous.entities.map(e => [e.id, e]));
  const byTable = new Map(previous.entities.map(e => [e.table.toLowerCase(), e]));
  for (const e of next.entities) {
    const old = byId.get(e.id) ?? byTable.get(e.table.toLowerCase());
    if (old) {
      e.x = old.x;
      e.y = old.y;
      e.color = old.color ?? e.color;
    }
  }
  return { ...next, name: previous.name || next.name, dialect: previous.dialect ?? next.dialect };
}

/** Validates and normalizes parsed JSON into a diagram (tolerating hand edits). */
export function parseDocument(text: string): ErdDocument {
  if (!text.trim()) {
    return emptyDocument('Untitled diagram');
  }
  const raw = JSON.parse(text) as Partial<ErdDocument>;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.entities)) {
    throw new Error('Not an ER diagram: an "entities" array is required.');
  }
  return {
    version: 1,
    name: raw.name ?? 'Untitled diagram',
    dialect: raw.dialect ?? 'postgresql',
    nativeDialect: raw.nativeDialect,
    source: raw.source,
    entities: raw.entities.map(e => ({
      ...e,
      id: e.id ?? e.table,
      kind: e.kind ?? 'table',
      columns: (e.columns ?? []).map(c => ({
        ...(Object.assign({ nullable: true, primaryKey: false, autoIncrement: false, unique: false }, c) as ErdColumn),
        type: (ERD_TYPES as readonly string[]).includes(c.type) ? c.type : 'VARCHAR',
      })),
    })),
    relationships: (raw.relationships ?? []).filter(r => r && r.from && r.to),
  };
}

export function serializeDocument(doc: ErdDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** A new unique entity id/table name like `table_3`. */
export function nextTableName(doc: ErdDocument, base = 'new_table'): string {
  let i = 1;
  let name = base;
  while (doc.entities.some(e => e.table === name || e.id === name)) {
    name = `${base}_${++i}`;
  }
  return name;
}

