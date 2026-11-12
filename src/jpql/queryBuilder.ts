/**
 * Builds JPQL queries (and matching Spring Data repository methods) from a simple specification,
 * as chosen in the "Generate JPQL Query" wizard. Pure module: no `vscode` imports.
 */
import { EntityModel, ModelAttribute, ModelClass } from './entityModel';

export type ConditionOp = '=' | '<>' | '<' | '<=' | '>' | '>=' | 'like' | 'in' | 'is null' | 'is not null';

export interface QueryCondition {
  /** Attribute path from the entity, e.g. ['customer', 'email']. */
  path: string[];
  op: ConditionOp;
}

export interface QuerySpec {
  entity: ModelClass;
  kind: 'list' | 'one' | 'count' | 'exists';
  conditions: QueryCondition[];
  /** Single-valued or collection associations to JOIN FETCH. */
  fetch: string[];
  orderBy?: { path: string[]; direction: 'asc' | 'desc' };
}

export interface BuiltQuery {
  jpql: string;
  methodName: string;
  returnType: string;
  params: Array<{ name: string; type: string; typeFqn?: string }>;
}

const pascal = (s: string) => s.charAt(0).toUpperCase() + s.substring(1);
const NO_ARG: ConditionOp[] = ['is null', 'is not null'];
const OP_KEYWORD: Record<ConditionOp, string> = {
  '=': '', '<>': 'Not', '<': 'LessThan', '<=': 'LessThanEqual', '>': 'GreaterThan', '>=': 'GreaterThanEqual',
  like: 'Like', in: 'In', 'is null': 'IsNull', 'is not null': 'IsNotNull',
};

/** Resolves an attribute path; returns undefined if any segment is unknown. */
export function attributePath(model: EntityModel, entity: ModelClass, path: string[]): ModelAttribute[] | undefined {
  const out: ModelAttribute[] = [];
  let cur: ModelClass | undefined = entity;
  for (const seg of path) {
    const a: ModelAttribute | undefined = cur?.attributes.get(seg);
    if (!a) {
      return undefined;
    }
    out.push(a);
    cur = model.target(a);
  }
  return out;
}

/** Paths offered as conditions: basic attributes plus basic attributes of to-one associations/embeddables. */
export function conditionPaths(model: EntityModel, entity: ModelClass): Array<{ path: string[]; attr: ModelAttribute }> {
  const out: Array<{ path: string[]; attr: ModelAttribute }> = [];
  for (const a of entity.attributes.values()) {
    const target = model.target(a);
    if (!target) {
      if (!a.collection) {
        out.push({ path: [a.name], attr: a });
      }
      continue;
    }
    if (a.collection) {
      continue;
    }
    for (const b of target.attributes.values()) {
      if (!model.target(b) && !b.collection) {
        out.push({ path: [a.name, b.name], attr: b });
      }
    }
  }
  return out;
}

export function buildQuery(model: EntityModel, spec: QuerySpec): BuiltQuery {
  const entityName = spec.entity.entityName ?? spec.entity.name;
  const initial = entityName.charAt(0).toLowerCase();
  const alias = /^[a-z]$/.test(initial) ? initial : 'e';
  const params: BuiltQuery['params'] = [];
  const usedNames = new Set<string>();
  const where: string[] = [];
  const nameParts: string[] = [];

  for (const c of spec.conditions) {
    const attrs = attributePath(model, spec.entity, c.path);
    const last = attrs?.[attrs.length - 1];
    const path = `${alias}.${c.path.join('.')}`;
    nameParts.push(c.path.map(pascal).join('') + OP_KEYWORD[c.op]);
    if (NO_ARG.includes(c.op)) {
      where.push(`${path} ${c.op}`);
      continue;
    }
    // customer.email → customerEmail: clearer than "email" and avoids clashes
    const name = c.path.length > 1 ? c.path[0] + pascal(c.path[c.path.length - 1]) : c.path[0];
    let unique = name;
    for (let i = 2; usedNames.has(unique); i++) {
      unique = `${name}${i}`;
    }
    usedNames.add(unique);
    const baseType = last?.type ?? 'Object';
    const type = c.op === 'in' ? `Collection<${boxed(baseType)}>` : baseType;
    params.push({ name: c.op === 'in' ? pluralParam(unique) : unique, type, typeFqn: last?.elementTypeFqn });
    const p = `:${params[params.length - 1].name}`;
    where.push(c.op === 'in' ? `${path} in ${p}` : c.op === 'like' ? `${path} like ${p}` : `${path} ${c.op} ${p}`);
  }

  const fetchJoins = spec.fetch.map(f => {
    const attr = spec.entity.attributes.get(f);
    return { name: f, collection: !!attr?.collection };
  });
  const hasCollectionFetch = fetchJoins.some(f => f.collection);
  const joins = fetchJoins.map(f => ` left join fetch ${alias}.${f.name}`).join('');

  let select: string;
  let returnType: string;
  let prefix: string;
  switch (spec.kind) {
    case 'count':
      select = `select count(${alias})`;
      returnType = 'long';
      prefix = 'countBy';
      break;
    case 'exists':
      select = `select case when count(${alias}) > 0 then true else false end`;
      returnType = 'boolean';
      prefix = 'existsBy';
      break;
    case 'one':
      select = `select ${hasCollectionFetch ? 'distinct ' : ''}${alias}`;
      returnType = `Optional<${spec.entity.name}>`;
      prefix = 'findBy';
      break;
    default:
      select = `select ${hasCollectionFetch ? 'distinct ' : ''}${alias}`;
      returnType = `List<${spec.entity.name}>`;
      prefix = 'findBy';
  }
  const order = spec.orderBy && (spec.kind === 'list' || spec.kind === 'one')
    ? ` order by ${alias}.${spec.orderBy.path.join('.')} ${spec.orderBy.direction}` : '';
  const jpql = `${select} from ${entityName} ${alias}${spec.kind === 'list' || spec.kind === 'one' ? joins : ''}${where.length ? ` where ${where.join(' and ')}` : ''}${order}`;

  let methodName: string;
  const withFetch = spec.fetch.length && (spec.kind === 'list' || spec.kind === 'one') ? `With${spec.fetch.map(pascal).join('And')}` : '';
  if (nameParts.length) {
    methodName = `${prefix.replace(/By$/, '')}${withFetch}By${nameParts.join('And')}`;
  } else {
    methodName = spec.kind === 'count' ? 'countAll' : spec.kind === 'exists' ? 'existsAny' : `findAll${withFetch}`;
  }
  if (order && spec.orderBy) {
    methodName += `OrderBy${spec.orderBy.path.map(pascal).join('')}${spec.orderBy.direction === 'desc' ? 'Desc' : 'Asc'}`;
  }
  return { jpql, methodName, returnType, params };
}

function boxed(t: string): string {
  return ({ int: 'Integer', long: 'Long', short: 'Short', byte: 'Byte', boolean: 'Boolean', double: 'Double', float: 'Float', char: 'Character' } as Record<string, string>)[t] ?? t;
}

function pluralParam(n: string): string {
  return /s$/.test(n) ? n : `${n}s`;
}

/** Renders a Java string literal for a JPQL query (escaping quotes and backslashes). */
export function javaStringLiteral(jpql: string): string {
  return `"${jpql.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
