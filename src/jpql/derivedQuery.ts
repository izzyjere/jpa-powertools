/**
 * Turns Spring Data derived query method names (findByCustomerEmailAndStatusOrderByPlacedAtDesc) into
 * equivalent JPQL, following Spring Data's PartTree grammar. Pure module: no `vscode` imports.
 */
import { EntityModel, ModelAttribute, ModelClass } from './entityModel';
import { MethodParam, MethodSignature } from './javaSource';
import { bindableParams } from './jpql';

export type DerivedResult =
  | { ok: true; jpql: string; params: MethodParam[]; usesSpel: boolean }
  | { ok: false; reason: string };

interface Keyword {
  suffixes: string[];
  args: number;
  build: (path: string, p: string[], ctx: { ignoreCase: boolean; collection: boolean }) => string;
}

const up = (s: string, ic: boolean) => (ic ? `upper(${s})` : s);

/** Longest suffixes first, as Spring Data matches them. */
const KEYWORDS: Keyword[] = [
  { suffixes: ['IsNotNull', 'NotNull'], args: 0, build: p => `${p} is not null` },
  { suffixes: ['IsNull', 'Null'], args: 0, build: p => `${p} is null` },
  { suffixes: ['IsLessThanEqual', 'LessThanEqual'], args: 1, build: (p, [a]) => `${p} <= ${a}` },
  { suffixes: ['IsLessThan', 'LessThan', 'IsBefore', 'Before'], args: 1, build: (p, [a]) => `${p} < ${a}` },
  { suffixes: ['IsGreaterThanEqual', 'GreaterThanEqual'], args: 1, build: (p, [a]) => `${p} >= ${a}` },
  { suffixes: ['IsGreaterThan', 'GreaterThan', 'IsAfter', 'After'], args: 1, build: (p, [a]) => `${p} > ${a}` },
  { suffixes: ['IsBetween', 'Between'], args: 2, build: (p, [a, b]) => `${p} between ${a} and ${b}` },
  { suffixes: ['IsNotLike', 'NotLike'], args: 1, build: (p, [a], c) => `${up(p, c.ignoreCase)} not like ${up(a, c.ignoreCase)}` },
  { suffixes: ['IsLike', 'Like'], args: 1, build: (p, [a], c) => `${up(p, c.ignoreCase)} like ${up(a, c.ignoreCase)}` },
  { suffixes: ['IsStartingWith', 'StartingWith', 'StartsWith'], args: 1, build: (p, [a], c) => likePattern(p, `concat(${a}, '%')`, c.ignoreCase) },
  { suffixes: ['IsEndingWith', 'EndingWith', 'EndsWith'], args: 1, build: (p, [a], c) => likePattern(p, `concat('%', ${a})`, c.ignoreCase) },
  {
    suffixes: ['IsNotContaining', 'NotContaining', 'NotContains'], args: 1,
    build: (p, [a], c) => (c.collection ? `${a} not member of ${p}` : likePattern(p, `concat('%', ${a}, '%')`, c.ignoreCase, true)),
  },
  {
    suffixes: ['IsContaining', 'Containing', 'Contains'], args: 1,
    build: (p, [a], c) => (c.collection ? `${a} member of ${p}` : likePattern(p, `concat('%', ${a}, '%')`, c.ignoreCase)),
  },
  { suffixes: ['IsNotIn', 'NotIn'], args: 1, build: (p, [a]) => `${p} not in ${a}` },
  { suffixes: ['IsIn', 'In'], args: 1, build: (p, [a]) => `${p} in ${a}` },
  { suffixes: ['IsNotEmpty', 'NotEmpty'], args: 0, build: p => `${p} is not empty` },
  { suffixes: ['IsEmpty', 'Empty'], args: 0, build: p => `${p} is empty` },
  { suffixes: ['IsTrue', 'True'], args: 0, build: p => `${p} = true` },
  { suffixes: ['IsFalse', 'False'], args: 0, build: p => `${p} = false` },
  { suffixes: ['IsNot', 'Not'], args: 1, build: (p, [a], c) => `${up(p, c.ignoreCase)} <> ${up(a, c.ignoreCase)}` },
  { suffixes: ['Is', 'Equals', ''], args: 1, build: (p, [a], c) => `${up(p, c.ignoreCase)} = ${up(a, c.ignoreCase)}` },
];
const UNSUPPORTED = ['Regex', 'MatchesRegex', 'Matches', 'Near', 'IsNear', 'Within', 'IsWithin', 'Exists'];

/** Spring escapes LIKE wildcards in derived queries; `escape()` keeps @Query semantics identical. */
function likePattern(path: string, pattern: string, ignoreCase: boolean, not = false): string {
  return `${up(path, ignoreCase)} ${not ? 'not ' : ''}like ${up(pattern, ignoreCase)} escape :#{escapeCharacter()}`;
}

const LIKE_KEYWORDS = /StartingWith|StartsWith|EndingWith|EndsWith|Containing|Contains/;

/** java.beans.Introspector.decapitalize: "URL" stays "URL", "Name" becomes "name". */
export function decapitalize(s: string): string {
  if (s.length > 1 && /[A-Z]/.test(s[0]) && /[A-Z]/.test(s[1])) {
    return s;
  }
  return s ? s[0].toLowerCase() + s.substring(1) : s;
}

/** Resolves a PartTree property expression ("CustomerEmail", "Customer_Email") to an attribute path. */
export function resolveProperty(cls: ModelClass, expr: string, model: EntityModel): ModelAttribute[] | undefined {
  if (expr.includes('_')) {
    const out: ModelAttribute[] = [];
    let cur: ModelClass | undefined = cls;
    for (const seg of expr.split('_').filter(Boolean)) {
      const attr: ModelAttribute | undefined = cur?.attributes.get(decapitalize(seg));
      if (!attr) {
        return undefined;
      }
      out.push(attr);
      cur = model.target(attr);
    }
    return out;
  }
  for (let len = expr.length; len > 0; len--) {
    const attr = cls.attributes.get(decapitalize(expr.substring(0, len)));
    if (!attr) {
      continue;
    }
    if (len === expr.length) {
      return [attr];
    }
    const target = model.target(attr);
    const rest = target && resolveProperty(target, expr.substring(len), model);
    if (rest) {
      return [attr, ...rest];
    }
  }
  return undefined;
}

const RESERVED_ALIASES = new Set(['as', 'by', 'in', 'is', 'of', 'on', 'or']);

function aliasFor(name: string, taken: Set<string>): string {
  let base = name.charAt(0).toLowerCase();
  if (RESERVED_ALIASES.has(base)) {
    base = 'x';
  }
  let alias = base;
  let i = 2;
  while (taken.has(alias)) {
    alias = `${base}${i++}`;
  }
  taken.add(alias);
  return alias;
}

/** Element type of a return type: `List<Order>` → `Order`, `Optional<Order>` → `Order`, `long` → `long`. */
export function returnElementType(returnType: string): string {
  const m = /^(?:[\w.]+\.)?(?:List|Set|Collection|Iterable|Optional|Stream|Page|Slice|Window|Streamable|Future|CompletableFuture|ListenableFuture|Mono|Flux)<\s*(.+)\s*>$/.exec(returnType.trim());
  return m ? returnElementType(m[1]) : returnType.trim().replace(/^.*\./, '');
}

export function deriveJpql(method: MethodSignature, entity: ModelClass, model: EntityModel): DerivedResult {
  // "<prefix><subject>By<predicate>", or a predicate-less "findAll" / "countDistinct"
  const m = /^(find|read|get|query|search|stream|count|exists|delete|remove)(.*?)By(.*)$/.exec(method.name)
    ?? /^(find|read|get|query|search|stream|count|exists)(All|Distinct|DistinctAll)?()$/.exec(method.name);
  if (!m) {
    return { ok: false, reason: `'${method.name}' is not a Spring Data derived query method` };
  }
  const [, prefix, subject, rest = ''] = m;
  if (prefix === 'delete' || prefix === 'remove') {
    return { ok: false, reason: 'Derived delete methods load and remove each entity (cascades, callbacks); a JPQL bulk delete behaves differently' };
  }
  if (/(First|Top)\d*/.test(subject)) {
    return { ok: false, reason: 'First/Top limits cannot be expressed in JPQL; keep the derived query or pass a Pageable/Limit' };
  }
  const distinct = /Distinct/.test(subject);
  const kind = prefix === 'count' ? 'count' : prefix === 'exists' ? 'exists' : 'find';

  if (kind === 'find') {
    const element = returnElementType(method.returnType);
    if (element !== entity.name && element !== 'T' && element !== '') {
      return { ok: false, reason: `${method.name}() returns ${element}, a projection: write the select clause yourself` };
    }
  }

  const params = bindableParams(method);
  let paramIdx = 0;
  const consumed: MethodParam[] = [];
  let usesSpel = false;
  const takeParam = (spelIndex: boolean): string | undefined => {
    const p = params[paramIdx++];
    if (!p) {
      return undefined;
    }
    consumed.push(p);
    if (spelIndex) {
      usesSpel = true;
      return `:#{escape([${method.params.indexOf(p)}])}`;
    }
    return `:${p.paramAnnotation ?? p.name}`;
  };

  const taken = new Set<string>();
  const root = aliasFor(entity.entityName ?? entity.name, taken);
  const joins: string[] = [];
  const joinAliases = new Map<string, string>();

  /** Builds the JPQL path for an attribute chain, joining collections that are traversed. */
  const pathOf = (attrs: ModelAttribute[], joinLastCollection: boolean): string => {
    let base = root;
    let key = root;
    attrs.forEach((a, i) => {
      const last = i === attrs.length - 1;
      if (a.collection && (!last || joinLastCollection)) {
        key = `${key}.${a.name}`;
        let alias = joinAliases.get(key);
        if (!alias) {
          alias = aliasFor(a.name, taken);
          joinAliases.set(key, alias);
          joins.push(`join ${base}.${a.name} ${alias}`);
        }
        base = alias;
      } else {
        base = `${base}.${a.name}`;
        key = `${key}.${a.name}`;
      }
    });
    return base;
  };

  let predicate = rest;
  let orderBy = '';
  const ob = predicate.search(/OrderBy(?=[A-Z])/);
  if (ob >= 0) {
    orderBy = predicate.substring(ob + 'OrderBy'.length);
    predicate = predicate.substring(0, ob);
  }
  let allIgnoreCase = false;
  const aic = /All(IgnoreCase|IgnoringCase)$/.exec(predicate);
  if (aic) {
    allIgnoreCase = true;
    predicate = predicate.substring(0, aic.index);
  }

  const orGroups: string[] = [];
  if (predicate) {
    for (const orPart of predicate.split(/(?<=[a-z0-9])Or(?=[A-Z])/)) {
      const ands: string[] = [];
      for (const raw of orPart.split(/(?<=[a-z0-9])And(?=[A-Z])/)) {
        let part = raw;
        let ignoreCase = allIgnoreCase;
        const ic = /(IgnoreCase|IgnoringCase)$/.exec(part);
        if (ic) {
          ignoreCase = true;
          part = part.substring(0, ic.index);
        }
        if (UNSUPPORTED.some(u => part.endsWith(u))) {
          return { ok: false, reason: `'${part}' uses a keyword JPQL does not support` };
        }
        let keyword: Keyword | undefined;
        let propertyExpr = part;
        let attrs: ModelAttribute[] | undefined;
        for (const k of KEYWORDS) {
          const suffix = k.suffixes.find(s => part.endsWith(s) && part.length > s.length);
          if (suffix === undefined) {
            continue;
          }
          const candidate = part.substring(0, part.length - suffix.length);
          const resolved = resolveProperty(entity, candidate, model);
          if (resolved) {
            keyword = k;
            propertyExpr = candidate;
            attrs = resolved;
            break;
          }
        }
        if (!keyword || !attrs) {
          return { ok: false, reason: `No property '${decapitalize(propertyExpr)}' found on ${entity.name}` };
        }
        const last = attrs[attrs.length - 1];
        const memberOrEmpty = /Containing|Contains|Empty/.test(part) && last.collection;
        const path = pathOf(attrs, !memberOrEmpty);
        const isLike = LIKE_KEYWORDS.test(part) && !last.collection;
        const args: string[] = [];
        for (let a = 0; a < keyword.args; a++) {
          const p = takeParam(isLike);
          if (!p) {
            return { ok: false, reason: `${method.name}() has fewer parameters than its name requires` };
          }
          args.push(p);
        }
        ands.push(keyword.build(path, args, { ignoreCase: ignoreCase && /String|char/i.test(last.elementType), collection: memberOrEmpty }));
      }
      orGroups.push(ands.join(' and '));
    }
  }

  const orders: string[] = [];
  if (orderBy) {
    const re = /(.+?)(Asc|Desc)(?=[A-Z]|$)/g;
    let consumedTo = 0;
    for (let om = re.exec(orderBy); om; om = re.exec(orderBy)) {
      const attrs = resolveProperty(entity, om[1], model);
      if (!attrs || attrs.slice(0, -1).some(a => a.collection)) {
        return { ok: false, reason: `Cannot order by '${decapitalize(om[1])}'` };
      }
      orders.push(`${pathOf(attrs, false)} ${om[2].toLowerCase()}`);
      consumedTo = re.lastIndex;
    }
    const tail = orderBy.substring(consumedTo);
    if (tail) {
      const attrs = resolveProperty(entity, tail, model);
      if (!attrs) {
        return { ok: false, reason: `Cannot order by '${decapitalize(tail)}'` };
      }
      orders.push(`${pathOf(attrs, false)} asc`);
    }
  }

  const entityName = entity.entityName ?? entity.name;
  let select: string;
  if (kind === 'count') {
    select = `select count(${distinct ? 'distinct ' : ''}${root})`;
  } else if (kind === 'exists') {
    select = `select case when count(${root}) > 0 then true else false end`;
  } else {
    select = `select ${distinct || joins.length ? 'distinct ' : ''}${root}`;
  }
  const where = orGroups.length ? ` where ${orGroups.length > 1 ? orGroups.map(g => (g.includes(' and ') ? `(${g})` : g)).join(' or ') : orGroups[0]}` : '';
  const order = orders.length && kind === 'find' ? ` order by ${orders.join(', ')}` : '';
  const jpql = `${select} from ${entityName} ${root}${joins.map(j => ` ${j}`).join('')}${where}${order}`;
  return { ok: true, jpql, params: consumed, usesSpel };
}
