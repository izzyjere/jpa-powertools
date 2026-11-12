import { ColumnInfo, DbKind, dialect, ForeignKeyInfo, TableInfo, tableKey } from '../model/types';
import {
  columnToFieldName, javaString, pluralize, safeIdentifier, tableToClassName, toCamelCase, toPascalCase, uniqueName,
} from './naming';
import { hasLength, hasPrecision, JavaTypeMapping, mapColumnType } from './typeMapping';

export interface GeneratorOptions {
  kind: DbKind;
  entityPackage: string;
  repositoryPackage: string;
  generateRepositories: boolean;
  persistenceApi: 'jakarta' | 'javax';
  lombok: boolean;
  /** Map foreign keys to @ManyToOne / @OneToOne associations. */
  relationships: boolean;
  /** Also generate the inverse @OneToMany / @OneToOne(mappedBy) side. */
  inverseRelationships: boolean;
  stripTablePrefixes: string[];
  /** Schema (or MySQL database) the application connects to by default; other schemas are written into @Table. */
  defaultSchema?: string;
  /** Write the schema into every @Table, even for the default schema. */
  alwaysIncludeSchema?: boolean;
  /** Map a numeric/timestamp column named `version` to @Version. */
  versionColumn: boolean;
}

export const DEFAULT_OPTIONS: Omit<GeneratorOptions, 'kind'> = {
  entityPackage: 'com.example.entity',
  repositoryPackage: 'com.example.repository',
  generateRepositories: true,
  persistenceApi: 'jakarta',
  lombok: false,
  relationships: true,
  inverseRelationships: false,
  stripTablePrefixes: [],
  versionColumn: true,
};

export interface GeneratedFile {
  /** Path relative to the source root, using forward slashes. */
  relativePath: string;
  packageName: string;
  className: string;
  kind: 'entity' | 'id' | 'repository';
  /** `schema.table` this file was generated from. */
  table: string;
  /** Table name (without schema) this file was generated from. */
  tableName: string;
  content: string;
}

export interface GenerationResult {
  files: GeneratedFile[];
  warnings: string[];
  /** `schema.table` → entity class name, for every input table. */
  classNames: Map<string, string>;
}

interface BasicField {
  kind: 'basic';
  name: string;
  column: ColumnInfo;
  mapping: JavaTypeMapping;
  id: boolean;
  generated: boolean;
  version: boolean;
  unique: boolean;
}

interface RelationField {
  kind: 'relation';
  name: string;
  oneToOne: boolean;
  targetClass: string;
  targetTable: TableInfo;
  fk: ForeignKeyInfo;
  readOnly: boolean;
  optional: boolean;
}

interface InverseField {
  kind: 'inverse';
  name: string;
  oneToOne: boolean;
  sourceClass: string;
  mappedBy: string;
}

type Field = BasicField | RelationField | InverseField;

interface EntityModel {
  table: TableInfo;
  className: string;
  idClassName?: string;
  idFields: BasicField[];
  fields: Field[];
  /** Field names in use, to keep generated names unique. */
  taken: Set<string>;
  notes: string[];
}

/** Simple names we import; an entity with the same name would not compile. */
const CLASHING_NAMES = new Set([
  'Entity', 'Table', 'Id', 'Column', 'GeneratedValue', 'GenerationType', 'ManyToOne', 'OneToOne', 'OneToMany',
  'JoinColumn', 'JoinColumns', 'FetchType', 'IdClass', 'Version', 'Lob', 'Immutable', 'JdbcTypeCode', 'SqlTypes',
  'Getter', 'Setter', 'NoArgsConstructor', 'EqualsAndHashCode', 'Serializable', 'Objects', 'List', 'ArrayList',
  'BigDecimal', 'BigInteger', 'LocalDate', 'LocalTime', 'LocalDateTime', 'OffsetDateTime', 'OffsetTime', 'Duration',
  'UUID', 'JpaRepository', 'String', 'Object', 'Integer', 'Long', 'Short', 'Byte', 'Boolean', 'Double', 'Float',
  'Class', 'Override', 'Deprecated', 'Record', 'Enum', 'Math', 'System', 'Thread', 'Character', 'Number',
]);

const SQL_RESERVED = new Set([
  'all', 'and', 'any', 'array', 'as', 'asc', 'between', 'both', 'by', 'case', 'cast', 'check', 'collate', 'column',
  'condition', 'constraint', 'create', 'cross', 'current_date', 'current_time', 'current_timestamp', 'current_user',
  'default', 'delete', 'desc', 'distinct', 'do', 'drop', 'else', 'end', 'except', 'exists', 'false', 'fetch', 'for',
  'foreign', 'from', 'full', 'grant', 'group', 'having', 'in', 'index', 'inner', 'insert', 'intersect', 'interval',
  'into', 'is', 'join', 'key', 'keys', 'leading', 'left', 'like', 'limit', 'natural', 'not', 'null', 'offset', 'on',
  'only', 'or', 'order', 'outer', 'primary', 'range', 'rank', 'read', 'references', 'release', 'right', 'row', 'rows',
  'select', 'session_user', 'table', 'then', 'to', 'trailing', 'true', 'union', 'unique', 'update', 'user', 'using',
  'values', 'when', 'where', 'window', 'with',
]);

/** Returns the identifier as it must appear inside a JPA name attribute (quoted when needed). */
export function sqlName(name: string, kind: DbKind): string {
  const folding = dialect(kind).identifierCase;
  const plain = folding === 'lower' ? /^[a-z_][a-z0-9_]*$/ : folding === 'upper' ? /^[A-Z_][A-Z0-9_$#]*$/ : /^[A-Za-z_][A-Za-z0-9_]*$/;
  if (plain.test(name) && !SQL_RESERVED.has(name.toLowerCase())) {
    return name;
  }
  return `"${name}"`;
}

export function generateEntities(tables: TableInfo[], options: GeneratorOptions): GenerationResult {
  const warnings: string[] = [];
  const byKey = new Map(tables.map(t => [tableKey(t.schema, t.name), t]));

  // 1. Class names, unique across the whole generation run.
  const classNames = new Map<string, string>();
  const takenClasses = new Set<string>();
  for (const t of tables) {
    let base = tableToClassName(t.name, options.stripTablePrefixes);
    if (CLASHING_NAMES.has(base)) {
      base += 'Entity';
    }
    classNames.set(tableKey(t.schema, t.name), uniqueName(base, takenClasses));
  }

  // 2. Basic fields + owning associations.
  const models = new Map<string, EntityModel>();
  for (const t of tables) {
    models.set(tableKey(t.schema, t.name), buildModel(t, classNames, byKey, takenClasses, options, warnings));
  }

  // 3. Inverse associations.
  if (options.relationships && options.inverseRelationships) {
    addInverseFields(models, classNames);
  }

  // 4. Render.
  const files: GeneratedFile[] = [];
  for (const model of models.values()) {
    const key = tableKey(model.table.schema, model.table.name);
    const t = model.table.name;
    files.push(file(options.entityPackage, model.className, 'entity', key, t, renderEntity(model, options)));
    if (model.idClassName) {
      files.push(file(options.entityPackage, model.idClassName, 'id', key, t, renderIdClass(model, options)));
    }
    if (options.generateRepositories) {
      const repoName = model.className + 'Repository';
      files.push(file(options.repositoryPackage, repoName, 'repository', key, t, renderRepository(model, options)));
    }
  }
  return { files, warnings, classNames };
}

function file(pkg: string, className: string, kind: GeneratedFile['kind'], table: string, tableName: string, content: string): GeneratedFile {
  const dir = pkg ? pkg.replace(/\./g, '/') + '/' : '';
  return { relativePath: `${dir}${className}.java`, packageName: pkg, className, kind, table, tableName, content };
}

function sameColumns(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every(c => b.includes(c));
}

function buildModel(
  table: TableInfo,
  classNames: Map<string, string>,
  byKey: Map<string, TableInfo>,
  takenClasses: Set<string>,
  options: GeneratorOptions,
  warnings: string[],
): EntityModel {
  const className = classNames.get(tableKey(table.schema, table.name))!;
  const notes: string[] = [];
  const columnNames = new Set(table.columns.map(c => c.name));

  // Identifier: primary key → first all-NOT-NULL unique key → every column.
  let idColumns = table.primaryKey.filter(c => columnNames.has(c));
  if (idColumns.length === 0) {
    const uk = table.uniqueKeys.find(k => k.columns.every(c => table.columns.find(col => col.name === c && !col.nullable)));
    if (uk) {
      idColumns = uk.columns;
      notes.push(`No primary key: unique key "${uk.name}" is used as the identifier.`);
    } else {
      idColumns = table.columns.map(c => c.name);
      notes.push('No primary key: all columns form the identifier. Consider adding a primary key.');
      if (table.kind === 'table') {
        warnings.push(`${table.name}: no primary key, all columns are used as the identifier.`);
      }
    }
  }

  // Decide which FK columns are written through an association instead of a basic field.
  const owned = new Set<string>();
  const relations: RelationField[] = [];
  if (options.relationships) {
    for (const fk of table.foreignKeys) {
      const target = byKey.get(tableKey(fk.referencedSchema, fk.referencedTable));
      if (!target || !fk.columns.every(c => columnNames.has(c))) {
        continue;
      }
      const readOnly = fk.columns.some(c => idColumns.includes(c) || owned.has(c));
      if (!readOnly) {
        fk.columns.forEach(c => owned.add(c));
      }
      const oneToOne = sameColumns(fk.columns, idColumns) || table.uniqueKeys.some(k => sameColumns(k.columns, fk.columns));
      const optional = fk.columns.some(c => table.columns.find(col => col.name === c)?.nullable);
      relations.push({
        kind: 'relation', name: '', oneToOne, targetClass: classNames.get(tableKey(target.schema, target.name))!,
        targetTable: target, fk, readOnly, optional,
      });
    }
  }

  const taken = new Set<string>();
  const basics = new Map<string, BasicField>();
  const singleUnique = new Set(table.uniqueKeys.filter(k => k.columns.length === 1).map(k => k.columns[0]));
  for (const col of table.columns) {
    if (owned.has(col.name)) {
      continue;
    }
    const mapping = mapColumnType(col, options.kind);
    if (mapping.unmapped) {
      notes.push(`Column "${col.name}" has type ${col.displayType}, which has no standard JPA mapping.`);
    }
    const isId = idColumns.includes(col.name);
    const isVersion = options.versionColumn && !isId && col.name.toLowerCase() === 'version'
      && ['Integer', 'Long', 'Short', 'LocalDateTime', 'OffsetDateTime'].includes(mapping.javaType);
    basics.set(col.name, {
      kind: 'basic', name: uniqueName(columnToFieldName(col.name), taken), column: col, mapping, id: isId,
      generated: isId && idColumns.length === 1 && col.autoIncrement, version: isVersion,
      unique: !isId && singleUnique.has(col.name),
    });
  }

  for (const rel of relations) {
    let base: string;
    const fkField = rel.fk.columns.length === 1 ? toCamelCase(rel.fk.columns[0]) : '';
    const stripped = fkField.replace(/(Id|Fk|Key|No|Code)$/, '');
    if (stripped && stripped !== fkField) {
      base = stripped;
    } else {
      base = toCamelCase(rel.targetClass);
    }
    rel.name = uniqueName(safeIdentifier(base), taken);
  }

  // Order: columns in table order, associations at their first FK column, read-only associations after.
  const fields: Field[] = [];
  const placed = new Set<RelationField>();
  for (const col of table.columns) {
    const basic = basics.get(col.name);
    if (basic) {
      fields.push(basic);
      continue;
    }
    const rel = relations.find(r => !r.readOnly && !placed.has(r) && r.fk.columns[0] === col.name);
    if (rel) {
      fields.push(rel);
      placed.add(rel);
    }
  }
  fields.push(...relations.filter(r => !placed.has(r)));

  const idFields = idColumns.map(c => basics.get(c)!).filter(Boolean);
  let idClassName: string | undefined;
  if (idFields.length > 1) {
    idClassName = uniqueName(className + 'Id', takenClasses);
  }

  return { table, className, idClassName, idFields, fields, taken, notes };
}

function addInverseFields(models: Map<string, EntityModel>, classNames: Map<string, string>): void {
  // Count associations per (source → target) pair to disambiguate names.
  const pairCount = new Map<string, number>();
  for (const m of models.values()) {
    for (const f of m.fields) {
      if (f.kind === 'relation') {
        const k = `${m.className}->${f.targetClass}`;
        pairCount.set(k, (pairCount.get(k) ?? 0) + 1);
      }
    }
  }
  for (const source of models.values()) {
    for (const f of source.fields) {
      if (f.kind !== 'relation') {
        continue;
      }
      const target = models.get(tableKey(f.targetTable.schema, f.targetTable.name));
      if (!target || !classNames.has(tableKey(f.targetTable.schema, f.targetTable.name))) {
        continue;
      }
      const sourceBase = toCamelCase(source.className);
      let base = f.oneToOne ? sourceBase : pluralize(sourceBase);
      if ((pairCount.get(`${source.className}->${f.targetClass}`) ?? 0) > 1 || source === target) {
        base += 'By' + toPascalCase(f.name);
      }
      target.fields.push({
        kind: 'inverse', name: uniqueName(safeIdentifier(base), target.taken), oneToOne: f.oneToOne,
        sourceClass: source.className, mappedBy: f.name,
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------- rendering

class Imports {
  private readonly set = new Set<string>();
  add(...names: string[]) {
    names.forEach(n => this.set.add(n));
  }
  render(currentPackage: string): string[] {
    const relevant = [...this.set].filter(i => i.substring(0, i.lastIndexOf('.')) !== currentPackage).sort();
    const other = relevant.filter(i => !i.startsWith('java.'));
    const java = relevant.filter(i => i.startsWith('java.'));
    const lines = other.map(i => `import ${i};`);
    if (other.length && java.length) {
      lines.push('');
    }
    lines.push(...java.map(i => `import ${i};`));
    return lines;
  }
}

function javadoc(text: string | null, indent: string): string[] {
  if (!text || !text.trim()) {
    return [];
  }
  const lines = text.replace(/\*\//g, '*&#47;').trim().split(/\r?\n/);
  if (lines.length === 1) {
    return [`${indent}/** ${lines[0]} */`];
  }
  return [`${indent}/**`, ...lines.map(l => `${indent} * ${l}`.trimEnd()), `${indent} */`];
}

function header(pkg: string, imports: Imports): string[] {
  const out: string[] = [];
  if (pkg) {
    out.push(`package ${pkg};`, '');
  }
  const imp = imports.render(pkg);
  if (imp.length) {
    out.push(...imp, '');
  }
  return out;
}

function fieldType(f: Field): string {
  switch (f.kind) {
    case 'basic': return f.mapping.javaType;
    case 'relation': return f.targetClass;
    case 'inverse': return f.oneToOne ? f.sourceClass : `List<${f.sourceClass}>`;
  }
}

function accessorSuffix(name: string): string {
  return name[0].toUpperCase() + name.substring(1);
}

function renderAccessors(fields: Array<{ name: string; type: string }>): string[] {
  const out: string[] = [];
  for (const f of fields) {
    const suffix = accessorSuffix(f.name);
    out.push(
      '',
      `    public ${f.type} get${suffix}() {`,
      `        return ${f.name};`,
      '    }',
      '',
      `    public void set${suffix}(${f.type} ${f.name}) {`,
      `        this.${f.name} = ${f.name};`,
      '    }',
    );
  }
  return out;
}

function renderEntity(model: EntityModel, o: GeneratorOptions): string {
  const p = `${o.persistenceApi}.persistence.`;
  const imports = new Imports();
  const { table } = model;
  const body: string[] = [];

  imports.add(p + 'Entity', p + 'Table');
  const classAnnotations: string[] = ['@Entity'];

  const tableAttrs = [`name = ${javaString(sqlName(table.name, o.kind))}`];
  if (table.schema && (o.alwaysIncludeSchema || (o.defaultSchema !== undefined && table.schema !== o.defaultSchema))) {
    tableAttrs.push(`${o.kind === 'mysql' || o.kind === 'mariadb' ? 'catalog' : 'schema'} = ${javaString(sqlName(table.schema, o.kind))}`);
  }
  classAnnotations.push(`@Table(${tableAttrs.join(', ')})`);
  if (model.idClassName) {
    imports.add(p + 'IdClass');
    classAnnotations.push(`@IdClass(${model.idClassName}.class)`);
  }
  if (table.kind === 'view') {
    imports.add('org.hibernate.annotations.Immutable');
    classAnnotations.push('@Immutable');
  }
  if (o.lombok) {
    imports.add('lombok.Getter', 'lombok.Setter', 'lombok.NoArgsConstructor');
    classAnnotations.push('@Getter', '@Setter', '@NoArgsConstructor');
  }

  const doc = [...(table.comment ? [table.comment] : []), ...model.notes.map(n => `<p>${n}</p>`)].join('\n');

  for (const f of model.fields) {
    body.push('');
    if (f.kind === 'basic') {
      body.push(...renderBasic(f, o, imports, p));
    } else if (f.kind === 'relation') {
      body.push(...renderRelation(f, o, imports, p));
    } else {
      body.push(...renderInverse(f, imports, p));
    }
  }

  if (!o.lombok) {
    body.push(...renderAccessors(model.fields.map(f => ({ name: f.name, type: fieldType(f) }))));
  }

  return [
    ...header(o.entityPackage, imports),
    ...javadoc(doc || null, ''),
    ...classAnnotations,
    `public class ${model.className} {`,
    ...body,
    '}',
    '',
  ].join('\n');
}

function renderBasic(f: BasicField, o: GeneratorOptions, imports: Imports, p: string): string[] {
  const out: string[] = [...javadoc(f.column.comment, '    ')];
  const c = f.column;
  if (f.id) {
    imports.add(p + 'Id');
    out.push('    @Id');
  }
  if (f.generated) {
    imports.add(p + 'GeneratedValue', p + 'GenerationType');
    out.push('    @GeneratedValue(strategy = GenerationType.IDENTITY)');
  }
  if (f.version) {
    imports.add(p + 'Version');
    out.push('    @Version');
  }
  if (f.mapping.lob) {
    imports.add(p + 'Lob');
    out.push('    @Lob');
  }
  if (f.mapping.json) {
    if (o.persistenceApi === 'jakarta') {
      imports.add('org.hibernate.annotations.JdbcTypeCode', 'org.hibernate.type.SqlTypes');
      out.push('    @JdbcTypeCode(SqlTypes.JSON)');
    } else {
      out.push(`    // TODO: ${c.displayType} column - map with a Hibernate type or AttributeConverter`);
    }
  }
  const attrsExtra: string[] = [];
  if (f.mapping.fixedChar) {
    if (o.persistenceApi === 'jakarta') {
      imports.add('org.hibernate.annotations.JdbcTypeCode', 'org.hibernate.type.SqlTypes');
      out.push(`    @JdbcTypeCode(SqlTypes.${f.mapping.fixedChar})`);
    } else if (c.length) {
      attrsExtra.push(`columnDefinition = ${javaString(`${f.mapping.fixedChar.toLowerCase()}(${c.length})`)}`);
    }
  }
  if (f.mapping.unmapped) {
    out.push(`    // TODO: no standard JPA mapping for SQL type ${c.displayType}; adjust the Java type or add a converter`);
  }
  const attrs = [`name = ${javaString(sqlName(c.name, o.kind))}`];
  if (!c.nullable && !f.id) {
    attrs.push('nullable = false');
  }
  if (f.unique) {
    attrs.push('unique = true');
  }
  if (hasLength(c, o.kind) && f.mapping.javaType !== 'Boolean') {
    attrs.push(`length = ${c.length}`);
  }
  if (hasPrecision(c, o.kind)) {
    attrs.push(`precision = ${c.precision}`);
    if (c.scale !== null && c.scale > 0) {
      attrs.push(`scale = ${c.scale}`);
    }
  }
  if (f.mapping.columnDefinition && !attrsExtra.some(a => a.startsWith('columnDefinition'))) {
    attrsExtra.push(`columnDefinition = ${javaString(f.mapping.columnDefinition)}`);
  }
  attrs.push(...attrsExtra);
  imports.add(p + 'Column');
  imports.add(...f.mapping.imports);
  out.push(`    @Column(${attrs.join(', ')})`);
  out.push(`    private ${f.mapping.javaType} ${f.name};`);
  return out;
}

function renderRelation(f: RelationField, o: GeneratorOptions, imports: Imports, p: string): string[] {
  const out: string[] = [];
  const annotation = f.oneToOne ? 'OneToOne' : 'ManyToOne';
  imports.add(p + annotation, p + 'FetchType', p + 'JoinColumn');
  const assocAttrs = ['fetch = FetchType.LAZY'];
  if (!f.optional) {
    assocAttrs.push('optional = false');
  }
  out.push(`    @${annotation}(${assocAttrs.join(', ')})`);

  const targetPk = f.targetTable.primaryKey;
  const needsRefName = !sameColumns(f.fk.referencedColumns, targetPk) || f.fk.columns.length > 1;
  const joinColumns = f.fk.columns.map((col, i) => {
    const attrs = [`name = ${javaString(sqlName(col, o.kind))}`];
    if (needsRefName && f.fk.referencedColumns[i]) {
      attrs.push(`referencedColumnName = ${javaString(sqlName(f.fk.referencedColumns[i], o.kind))}`);
    }
    if (!f.optional && !f.readOnly) {
      attrs.push('nullable = false');
    }
    if (f.readOnly) {
      attrs.push('insertable = false', 'updatable = false');
    }
    return `@JoinColumn(${attrs.join(', ')})`;
  });
  if (joinColumns.length === 1) {
    out.push(`    ${joinColumns[0]}`);
  } else {
    imports.add(p + 'JoinColumns');
    out.push('    @JoinColumns({', ...joinColumns.map((j, i) => `        ${j}${i < joinColumns.length - 1 ? ',' : ''}`), '    })');
  }
  out.push(`    private ${f.targetClass} ${f.name};`);
  return out;
}

function renderInverse(f: InverseField, imports: Imports, p: string): string[] {
  if (f.oneToOne) {
    imports.add(p + 'OneToOne');
    return [`    @OneToOne(mappedBy = ${javaString(f.mappedBy)})`, `    private ${f.sourceClass} ${f.name};`];
  }
  imports.add(p + 'OneToMany', 'java.util.List', 'java.util.ArrayList');
  return [
    `    @OneToMany(mappedBy = ${javaString(f.mappedBy)})`,
    `    private List<${f.sourceClass}> ${f.name} = new ArrayList<>();`,
  ];
}

function renderIdClass(model: EntityModel, o: GeneratorOptions): string {
  const name = model.idClassName!;
  const imports = new Imports();
  imports.add('java.io.Serializable', 'java.util.Objects');
  model.idFields.forEach(f => imports.add(...f.mapping.imports));
  const annotations: string[] = [];
  if (o.lombok) {
    imports.add('lombok.Getter', 'lombok.Setter', 'lombok.NoArgsConstructor');
    annotations.push('@Getter', '@Setter', '@NoArgsConstructor');
  }
  const fields = model.idFields.map(f => `    private ${f.mapping.javaType} ${f.name};`);
  const names = model.idFields.map(f => f.name);
  const equalsBody = names.map(n => (model.idFields.find(f => f.name === n)!.mapping.javaType === 'byte[]'
    ? `java.util.Arrays.equals(${n}, that.${n})`
    : `Objects.equals(${n}, that.${n})`));
  const hashArgs = names.map(n => (model.idFields.find(f => f.name === n)!.mapping.javaType === 'byte[]'
    ? `java.util.Arrays.hashCode(${n})` : n));

  return [
    ...header(o.entityPackage, imports),
    `/** Composite identifier of {@link ${model.className}}. */`,
    ...annotations,
    `public class ${name} implements Serializable {`,
    '',
    ...fields,
    ...(o.lombok ? [] : ['', `    public ${name}() {`, '    }']),
    '',
    `    public ${name}(${model.idFields.map(f => `${f.mapping.javaType} ${f.name}`).join(', ')}) {`,
    ...names.map(n => `        this.${n} = ${n};`),
    '    }',
    ...(o.lombok ? [] : renderAccessors(model.idFields.map(f => ({ name: f.name, type: f.mapping.javaType })))),
    '',
    '    @Override',
    '    public boolean equals(Object o) {',
    '        if (this == o) {',
    '            return true;',
    '        }',
    `        if (!(o instanceof ${name})) {`,
    '            return false;',
    '        }',
    `        ${name} that = (${name}) o;`,
    `        return ${equalsBody.join('\n            && ')};`,
    '    }',
    '',
    '    @Override',
    '    public int hashCode() {',
    `        return Objects.hash(${hashArgs.join(', ')});`,
    '    }',
    '}',
    '',
  ].join('\n');
}

function renderRepository(model: EntityModel, o: GeneratorOptions): string {
  const imports = new Imports();
  imports.add('org.springframework.data.jpa.repository.JpaRepository');
  const entityFqn = (n: string) => (o.entityPackage ? `${o.entityPackage}.${n}` : n);
  if (o.entityPackage !== o.repositoryPackage && o.entityPackage) {
    imports.add(entityFqn(model.className));
  }
  let idType: string;
  if (model.idClassName) {
    idType = model.idClassName;
    if (o.entityPackage !== o.repositoryPackage && o.entityPackage) {
      imports.add(entityFqn(model.idClassName));
    }
  } else {
    const idField = model.idFields[0];
    idType = idField ? idField.mapping.javaType : 'Long';
    if (idField) {
      imports.add(...idField.mapping.imports);
    }
  }
  return [
    ...header(o.repositoryPackage, imports),
    `public interface ${model.className}Repository extends JpaRepository<${model.className}, ${idType}> {`,
    '}',
    '',
  ].join('\n');
}
