/**
 * JPQL / HQL analysis against an entity model: diagnostics, references, parameters and completion.
 * The analysis is deliberately tolerant: it only reports problems it is sure about, so valid HQL
 * extensions (functions, implicit aliases, enum literals, …) never produce false errors.
 * Pure module: no `vscode` imports.
 */
import { EntityModel, ModelAttribute, ModelClass, suggest } from './entityModel';
import { MethodParam, MethodSignature } from './javaSource';

export type JpqlTokenType = 'ident' | 'string' | 'number' | 'param' | 'op' | 'punct';

export interface JpqlToken {
  type: JpqlTokenType;
  text: string;
  upper: string;
  start: number;
  end: number;
}

export interface JpqlDiagnostic {
  start: number;
  end: number;
  message: string;
  severity: 'error' | 'warning';
  code: 'syntax' | 'unknown-entity' | 'unknown-attribute' | 'unknown-alias' | 'basic-path' | 'collection-path' | 'parameter';
  /** Text that fixes the problem when it replaces [start, end). */
  replacement?: string;
}

export interface JpqlReference {
  start: number;
  end: number;
  kind: 'entity' | 'attribute';
  cls: ModelClass;
  attribute?: ModelAttribute;
}

export interface JpqlParameter {
  name?: string;
  position?: number;
  spel?: boolean;
  start: number;
  end: number;
}

interface AliasInfo {
  name: string;
  type?: ModelClass;
  start: number;
  end: number;
}

interface Scope {
  from: number;
  to: number;
  parent?: Scope;
  aliases: Map<string, AliasInfo>;
  children: Scope[];
}

export interface JpqlAnalysis {
  tokens: JpqlToken[];
  diagnostics: JpqlDiagnostic[];
  references: JpqlReference[];
  parameters: JpqlParameter[];
  /** Aliases visible somewhere in the query (all scopes), for completion. */
  scopes: Scope[];
}

const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'HAVING', 'ORDER', 'ASC', 'DESC', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL',
  'CROSS', 'FETCH', 'ON', 'WITH', 'AS', 'DISTINCT', 'NEW', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'EMPTY', 'MEMBER', 'OF', 'LIKE',
  'ILIKE', 'ESCAPE', 'BETWEEN', 'EXISTS', 'ALL', 'ANY', 'SOME', 'UPDATE', 'SET', 'DELETE', 'INSERT', 'INTO', 'VALUES', 'CASE', 'WHEN',
  'THEN', 'ELSE', 'END', 'TRUE', 'FALSE', 'UNION', 'INTERSECT', 'EXCEPT', 'LIMIT', 'OFFSET', 'FIRST', 'NEXT', 'ROWS', 'ROW', 'ONLY',
  'NULLS', 'LAST', 'TREAT', 'TYPE', 'KEY', 'VALUE', 'ENTRY', 'INDEX', 'OBJECT', 'ELEMENT', 'ELEMENTS',
]);

/** Keywords that end a FROM list or a join declaration. */
const CLAUSE_END = new Set([
  'WHERE', 'GROUP', 'HAVING', 'ORDER', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'UNION', 'INTERSECT', 'EXCEPT',
  'LIMIT', 'OFFSET', 'FETCH', 'SET', 'ON', 'WITH',
]);

/** Pseudo attributes HQL accepts on paths. */
const PSEUDO_ATTRIBUTES = new Set(['id', 'class', 'size', 'elements', 'indices', 'minelement', 'maxelement', 'minindex', 'maxindex']);

export function lexJpql(q: string, diagnostics: JpqlDiagnostic[] = []): JpqlToken[] {
  const tokens: JpqlToken[] = [];
  const push = (type: JpqlTokenType, start: number, end: number) => {
    const text = q.substring(start, end);
    tokens.push({ type, text, upper: text.toUpperCase(), start, end });
  };
  let i = 0;
  while (i < q.length) {
    const c = q[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '\'' || c === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= q.length) {
          diagnostics.push({ start: i, end: q.length, message: 'Unterminated string literal', severity: 'error', code: 'syntax' });
          break;
        }
        if (q[j] === c) {
          if (q[j + 1] === c) {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      push('string', i, Math.min(j, q.length));
      i = j;
      continue;
    }
    if ((c === ':' || c === '?') && q[i + 1] === '#' && q[i + 2] === '{') {
      // SpEL expression: :#{…} / ?#{…}
      let depth = 0;
      let j = i + 2;
      for (; j < q.length; j++) {
        if (q[j] === '{') {
          depth++;
        } else if (q[j] === '}' && --depth === 0) {
          j++;
          break;
        }
      }
      push('param', i, j);
      i = j;
      continue;
    }
    if (c === ':' && /[\p{L}_$]/u.test(q[i + 1] ?? '')) {
      let j = i + 2;
      while (j < q.length && /[\p{L}\p{N}_$]/u.test(q[j])) {
        j++;
      }
      push('param', i, j);
      i = j;
      continue;
    }
    if (c === '?') {
      let j = i + 1;
      while (j < q.length && /[0-9]/.test(q[j])) {
        j++;
      }
      push('param', i, j);
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(q[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < q.length && /[0-9.]/.test(q[j])) {
        j++;
      }
      if (/[eE]/.test(q[j] ?? '') && /[-+0-9]/.test(q[j + 1] ?? '')) {
        j += 2;
        while (j < q.length && /[0-9]/.test(q[j])) {
          j++;
        }
      }
      while (j < q.length && /[a-zA-Z]/.test(q[j])) {
        j++; // 10L, 1.5F, 2BD
      }
      push('number', i, j);
      i = j;
      continue;
    }
    if (/[\p{L}_$]/u.test(c)) {
      let j = i + 1;
      while (j < q.length && /[\p{L}\p{N}_$]/u.test(q[j])) {
        j++;
      }
      push('ident', i, j);
      i = j;
      continue;
    }
    const two = q.substring(i, i + 2);
    if (['<>', '!=', '>=', '<=', '||', '^='].includes(two)) {
      push('op', i, i + 2);
      i += 2;
      continue;
    }
    if ('=<>+-*/%'.includes(c)) {
      push('op', i, i + 1);
      i++;
      continue;
    }
    if ('(),.{}[]'.includes(c)) {
      push('punct', i, i + 1);
      i++;
      continue;
    }
    diagnostics.push({ start: i, end: i + 1, message: `Unexpected character '${c}'`, severity: 'error', code: 'syntax' });
    i++;
  }
  return tokens;
}

const isKeyword = (t: JpqlToken | undefined, ...words: string[]) => !!t && t.type === 'ident' && (words.length ? words.includes(t.upper) : KEYWORDS.has(t.upper));

export interface AnalyzeOptions {
  /** Report unknown entities (off when the workspace has no entity sources). */
  checkEntities?: boolean;
}

export function analyzeJpql(q: string, model: EntityModel, opts: AnalyzeOptions = {}): JpqlAnalysis {
  const diagnostics: JpqlDiagnostic[] = [];
  const references: JpqlReference[] = [];
  const parameters: JpqlParameter[] = [];
  const tokens = lexJpql(q, diagnostics);
  const checkEntities = opts.checkEntities ?? !model.isEmpty;
  const err = (start: number, end: number, message: string, code: JpqlDiagnostic['code'], replacement?: string, severity: 'error' | 'warning' = 'error') =>
    diagnostics.push({ start, end, message, severity, code, replacement });

  if (tokens.length === 0) {
    err(0, q.length, 'The query is empty', 'syntax');
    return { tokens, diagnostics, references, parameters, scopes: [] };
  }

  // ---- parentheses
  const match = new Array<number>(tokens.length).fill(-1);
  const stack: number[] = [];
  tokens.forEach((t, i) => {
    if (t.text === '(') {
      stack.push(i);
    } else if (t.text === ')') {
      const open = stack.pop();
      if (open === undefined) {
        err(t.start, t.end, 'Unmatched closing parenthesis', 'syntax');
      } else {
        match[open] = i;
        match[i] = open;
      }
    }
  });
  for (const open of stack) {
    err(tokens[open].start, tokens[open].end, 'Unclosed parenthesis', 'syntax');
    match[open] = tokens.length;
  }

  if (!isKeyword(tokens[0], 'SELECT', 'UPDATE', 'DELETE', 'FROM', 'INSERT', 'WITH')) {
    err(tokens[0].start, tokens[0].end, `A JPQL query starts with SELECT, UPDATE or DELETE, not '${tokens[0].text}'`, 'syntax');
  }

  // ---- scopes (main query and subqueries)
  const scopes: Scope[] = [];
  const build = (from: number, to: number, parent?: Scope): Scope => {
    const scope: Scope = { from, to, parent, aliases: new Map(), children: [] };
    scopes.push(scope);
    for (let i = from; i < to; i++) {
      if (tokens[i].text === '(' && isKeyword(tokens[i + 1], 'SELECT', 'FROM') && match[i] > i) {
        scope.children.push(build(i + 1, Math.min(match[i], to), scope));
        i = Math.min(match[i], to) - 1;
      }
    }
    return scope;
  };
  const root = build(0, tokens.length);
  const ownIndexes = (scope: Scope): number[] => {
    const out: number[] = [];
    for (let i = scope.from; i < scope.to; i++) {
      const child = scope.children.find(c => c.from === i);
      if (child) {
        i = child.to - 1;
        continue;
      }
      out.push(i);
    }
    return out;
  };
  const lookupAlias = (scope: Scope | undefined, name: string): AliasInfo | undefined => {
    for (let s = scope; s; s = s.parent) {
      const a = s.aliases.get(name.toLowerCase());
      if (a) {
        return a;
      }
    }
    return undefined;
  };

  const resolveEntity = (startTok: number, endTok: number): ModelClass | undefined => {
    const name = tokens.slice(startTok, endTok).map(t => t.text).join('');
    const start = tokens[startTok].start;
    const end = tokens[endTok - 1].end;
    const cls = model.entity(name);
    if (cls) {
      references.push({ start, end, kind: 'entity', cls });
      return cls;
    }
    if (checkEntities) {
      const names = model.entities().map(e => e.entityName!);
      const s = suggest(name, names);
      if (s && s.toLowerCase() === name.toLowerCase()) {
        err(start, end, `Entity names are case-sensitive: did you mean '${s}'?`, 'unknown-entity', s);
      } else {
        err(start, end, `Unknown entity '${name}'${s ? `. Did you mean '${s}'?` : ''}`, 'unknown-entity', s, 'warning');
      }
    }
    return undefined;
  };

  /** Resolves a dotted path whose root is an alias; returns the class the path ends at (undefined if unknown/basic). */
  const resolvePath = (scope: Scope, idx: number[]): ModelClass | undefined => {
    const rootTok = tokens[idx[0]];
    const alias = lookupAlias(scope, rootTok.text);
    if (!alias) {
      return undefined;
    }
    let cur = alias.type;
    let prevCollection: ModelAttribute | undefined;
    for (let s = 1; s < idx.length; s++) {
      const seg = tokens[idx[s]];
      if (!cur) {
        return undefined;
      }
      if (prevCollection && !PSEUDO_ATTRIBUTES.has(seg.text)) {
        err(seg.start, seg.end, `'${prevCollection.name}' is a collection; join it to reach '${seg.text}' (e.g. JOIN ${tokens.slice(idx[0], idx[s - 1] + 1).map(t => t.text).join('')} x)`, 'collection-path');
        return undefined;
      }
      const attr = cur.attributes.get(seg.text);
      if (!attr) {
        if (cur.incomplete || PSEUDO_ATTRIBUTES.has(seg.text)) {
          return undefined;
        }
        const s2 = suggest(seg.text, cur.attributes.keys());
        err(seg.start, seg.end, `${cur.kind === 'embeddable' ? 'Embeddable' : 'Entity'} '${cur.entityName ?? cur.name}' has no attribute '${seg.text}'${s2 ? `. Did you mean '${s2}'?` : ''}`, 'unknown-attribute', s2);
        return undefined;
      }
      references.push({ start: seg.start, end: seg.end, kind: 'attribute', cls: cur, attribute: attr });
      const next = model.target(attr);
      if (!next && s < idx.length - 1 && model.isKnownBasic(attr) && !PSEUDO_ATTRIBUTES.has(tokens[idx[s + 1]].text)) {
        const nextSeg = tokens[idx[s + 1]];
        err(nextSeg.start, nextSeg.end, `'${attr.name}' is a basic attribute (${attr.type}) and has no attribute '${nextSeg.text}'`, 'basic-path');
        return undefined;
      }
      prevCollection = attr.collection ? attr : undefined;
      cur = next;
    }
    return cur;
  };

  /** Reads a dotted chain starting at own[p]; returns token indexes and the next position. */
  const chainAt = (own: number[], p: number): { idx: number[]; next: number } => {
    const idx = [own[p]];
    let q2 = p + 1;
    while (tokens[own[q2]]?.text === '.' && tokens[own[q2 + 1]]?.type === 'ident' && own[q2 + 1] === own[q2] + 1 && own[q2] === idx[idx.length - 1] + 1) {
      idx.push(own[q2 + 1]);
      q2 += 2;
    }
    return { idx, next: q2 };
  };

  const consumed = new Set<number>();

  for (const scope of scopes) {
    const own = ownIndexes(scope);
    const depthAt: number[] = [];
    let depth = 0;
    for (const i of own) {
      if (tokens[i].text === '(') {
        depth++;
      }
      depthAt.push(depth);
      if (tokens[i].text === ')') {
        depth--;
      }
    }
    const tokAt = (p: number) => tokens[own[p]];
    const declareAlias = (p: number, type: ModelClass | undefined): number => {
      if (isKeyword(tokAt(p), 'AS')) {
        p++;
      }
      const t = tokAt(p);
      if (t && t.type === 'ident' && !CLAUSE_END.has(t.upper) && !KEYWORDS.has(t.upper)) {
        scope.aliases.set(t.text.toLowerCase(), { name: t.text, type, start: t.start, end: t.end });
        consumed.add(own[p]);
        return p + 1;
      }
      return p;
    };

    for (let p = 0; p < own.length; p++) {
      const t = tokAt(p);
      // Declarations only at the scope's top level (FROM inside extract(…)/trim(…) is a function argument).
      if (depthAt[p] !== 0) {
        continue;
      }
      if (isKeyword(t, 'FROM') || (isKeyword(t, 'UPDATE') && p === 0)) {
        let r = p + 1;
        for (;;) {
          const et = tokAt(r);
          // Entity names may collide with keywords (an entity called Order): only ORDER/GROUP BY end the list.
          const entityLike = !!et && model.entities().some(e => e.entityName!.toLowerCase() === et.text.toLowerCase());
          const isClause = !!et && CLAUSE_END.has(et.upper) && !(entityLike && !isKeyword(tokAt(r + 1), 'BY'));
          if (!et || et.type !== 'ident' || isClause || isKeyword(et, 'SELECT')) {
            break;
          }
          const { idx, next } = chainAt(own, r);
          idx.forEach(i => consumed.add(i));
          const cls = resolveEntity(idx[0], idx[idx.length - 1] + 1);
          r = declareAlias(next, cls);
          if (tokAt(r)?.text === ',') {
            r++;
            continue;
          }
          break;
        }
        p = r - 1;
      } else if (isKeyword(t, 'JOIN')) {
        let r = p + 1;
        if (isKeyword(tokAt(r), 'FETCH')) {
          r++;
        }
        let type: ModelClass | undefined;
        const jt = tokAt(r);
        if (isKeyword(jt, 'TREAT') && tokAt(r + 1)?.text === '(') {
          const { idx, next } = chainAt(own, r + 2);
          idx.forEach(i => consumed.add(i));
          if (idx.length > 1) {
            resolvePath(scope, idx);
          }
          let x = next;
          if (isKeyword(tokAt(x), 'AS')) {
            const sub = chainAt(own, x + 1);
            sub.idx.forEach(i => consumed.add(i));
            type = resolveEntity(sub.idx[0], sub.idx[sub.idx.length - 1] + 1);
            x = sub.next;
          }
          r = tokAt(x)?.text === ')' ? x + 1 : x;
        } else if (jt?.type === 'ident') {
          const { idx, next } = chainAt(own, r);
          idx.forEach(i => consumed.add(i));
          if (idx.length > 1) {
            if (lookupAlias(scope, tokens[idx[0]].text)) {
              type = resolvePath(scope, idx);
            } else if (scope.aliases.size > 0 && /^[a-z]/.test(tokens[idx[0]].text)) {
              err(tokens[idx[0]].start, tokens[idx[0]].end, `Unknown alias '${tokens[idx[0]].text}'`, 'unknown-alias',
                suggest(tokens[idx[0]].text, [...scope.aliases.values()].map(a => a.name)));
            }
          } else {
            type = resolveEntity(idx[0], idx[0] + 1);
          }
          r = next;
        }
        p = declareAlias(r, type) - 1;
      }
    }

    // ---- path expressions
    for (let p = 0; p < own.length; p++) {
      const i = own[p];
      const t = tokens[i];
      if (t.type !== 'ident' || consumed.has(i) || tokens[i - 1]?.text === '.') {
        continue;
      }
      if (isKeyword(tokens[i - 1], 'NEW')) {
        // constructor expression: skip the class name
        while (tokens[own[p + 1]]?.text === '.' && tokens[own[p + 2]]?.type === 'ident') {
          p += 2;
        }
        continue;
      }
      if (tokens[i + 1]?.text !== '.' || tokens[i + 2]?.type !== 'ident') {
        continue;
      }
      const { idx, next } = chainAt(own, p);
      p = next - 1;
      if (lookupAlias(scope, t.text)) {
        resolvePath(scope, idx);
        continue;
      }
      // Not an alias: entity names, class constants and enum literals (com.acme.Status.PAID) are fine.
      const segments = idx.map(x => tokens[x].text);
      const looksQualified = /^[A-Z]/.test(segments[0]) || segments.slice(1).some(s => /^[A-Z]/.test(s)) || model.entity(segments[0]);
      if (!looksQualified && scopeHasAliases(scope)) {
        const candidates = allAliases(scope).map(a => a.name);
        const s = suggest(t.text, candidates);
        err(t.start, t.end, `Unknown alias '${t.text}'${s ? `. Did you mean '${s}'?` : ''}`, 'unknown-alias', s);
      }
    }
  }

  // ---- parameters
  for (const t of tokens) {
    if (t.type !== 'param') {
      continue;
    }
    if (t.text.startsWith(':#{') || t.text.startsWith('?#{')) {
      parameters.push({ spel: true, start: t.start, end: t.end });
    } else if (t.text.startsWith(':')) {
      parameters.push({ name: t.text.substring(1), start: t.start, end: t.end });
    } else {
      const position = t.text.length > 1 ? Number(t.text.substring(1)) : undefined;
      parameters.push({ position, start: t.start, end: t.end });
      if (position === undefined) {
        err(t.start, t.end, 'JPQL positional parameters are numbered: use ?1, ?2, …', 'parameter', undefined, 'warning');
      } else if (position === 0) {
        err(t.start, t.end, 'Positional parameters start at ?1', 'parameter');
      }
    }
  }
  const named = parameters.filter(x => x.name);
  const positional = parameters.filter(x => x.position !== undefined);
  if (named.length && positional.length) {
    err(positional[0].start, positional[0].end, 'Do not mix named (:name) and positional (?1) parameters in one query', 'parameter');
  }

  // ---- common syntax slips
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    if (consumed.has(i) || tokens[i - 1]?.text === '.') {
      continue; // entity names, aliases and path segments (an attribute may be called "order")
    }
    if (isKeyword(t, 'ORDER', 'GROUP') && !isKeyword(next, 'BY')) {
      err(t.start, t.end, `${t.upper} must be followed by BY`, 'syntax', `${t.text} by`);
    }
    if (isKeyword(t, 'SELECT') && isKeyword(next, 'FROM')) {
      err(t.start, next.end, 'The SELECT clause is empty', 'syntax');
    }
    if (isKeyword(t, 'WHERE', 'HAVING', 'ON') && (isKeyword(next, 'ORDER', 'GROUP', 'HAVING') || next?.text === ')')) {
      err(t.start, t.end, `${t.upper} needs a condition`, 'syntax');
    }
    if (t.text === ',' && (isKeyword(next, 'FROM', 'WHERE', 'ORDER', 'GROUP') || next?.text === ',' || next?.text === ')')) {
      err(t.start, t.end, 'Unexpected comma', 'syntax', '');
    }
    if (isKeyword(t, 'AND', 'OR') && isKeyword(next, 'AND', 'OR', 'ORDER', 'GROUP')) {
      err(t.start, t.end, `${t.upper} needs a condition after it`, 'syntax');
    }
  }
  const last = tokens[tokens.length - 1];
  if (isKeyword(last, 'WHERE', 'AND', 'OR', 'BY', 'FROM', 'JOIN', 'ON', 'SET', 'SELECT', 'HAVING', 'NOT', 'IN', 'LIKE', 'BETWEEN', 'AS', 'FETCH', 'DISTINCT', 'IS')
    || (last.type === 'op' && last.text !== '*') || last.text === ',' || last.text === '.') {
    err(last.start, last.end, `The query is incomplete after '${last.text}'`, 'syntax');
  }

  // keep only the first diagnostic per range
  const seen = new Set<string>();
  const unique = diagnostics.filter(d => {
    const k = `${d.start}:${d.end}:${d.code}`;
    if (seen.has(k)) {
      return false;
    }
    seen.add(k);
    return true;
  });
  return { tokens, diagnostics: unique, references, parameters, scopes };

  function scopeHasAliases(scope: Scope): boolean {
    return allAliases(scope).length > 0;
  }
  function allAliases(scope: Scope): AliasInfo[] {
    const out: AliasInfo[] = [];
    for (let s: Scope | undefined = scope; s; s = s.parent) {
      out.push(...s.aliases.values());
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------- parameters

/** Method parameters Spring Data binds specially (never to query parameters). */
const SPECIAL_PARAM_TYPES = /^(Pageable|Sort|Limit|ScrollPosition|KeysetScrollPosition|OffsetScrollPosition|Class<.*>|ScoringFunction|Score|Range<.*>)$/;

export function bindableParams(method: MethodSignature): MethodParam[] {
  return method.params.filter(p => !SPECIAL_PARAM_TYPES.test(p.type.replace(/\s/g, '')));
}

export interface ParameterCheck {
  /** Problems inside the query (query coordinates). */
  query: JpqlDiagnostic[];
  /** Method parameters Spring Data cannot bind to the query (reported on the parameter). */
  unboundParams: Array<{ param: MethodParam; message: string }>;
}

/** Checks query parameters against the annotated Spring Data repository method. */
export function checkMethodParameters(analysis: JpqlAnalysis, method: MethodSignature): ParameterCheck {
  const result: ParameterCheck = { query: [], unboundParams: [] };
  const params = bindableParams(method);
  const usesSpel = analysis.parameters.some(p => p.spel);
  const named = analysis.parameters.filter(p => p.name);
  const nameOf = (p: MethodParam) => p.paramAnnotation ?? p.name;
  for (const qp of named) {
    if (!params.some(p => nameOf(p) === qp.name)) {
      const s = suggest(qp.name!, params.map(nameOf));
      result.query.push({
        start: qp.start, end: qp.end, severity: 'error', code: 'parameter', replacement: s ? `:${s}` : undefined,
        message: `No method parameter is bound to ':${qp.name}'.${s ? ` Did you mean ':${s}'?` : ` Add @Param("${qp.name}") to a parameter of ${method.name}().`}`,
      });
    }
  }
  for (const qp of analysis.parameters.filter(p => p.position !== undefined)) {
    if (qp.position! > params.length) {
      result.query.push({
        start: qp.start, end: qp.end, severity: 'error', code: 'parameter',
        message: `?${qp.position} has no matching parameter: ${method.name}() binds ${params.length} parameter${params.length === 1 ? '' : 's'}`,
      });
    }
  }
  if (named.length && !usesSpel) {
    const used = new Set(named.map(p => p.name));
    for (const p of params) {
      if (!used.has(nameOf(p))) {
        result.unboundParams.push({
          param: p,
          message: p.paramAnnotation
            ? `@Param("${p.paramAnnotation}") is not used in the query; Spring Data fails at startup`
            : `Parameter '${p.name}' is not used in the query; Spring Data fails at startup. Reference it as :${p.name} or remove it`,
        });
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------- navigation

export function referenceAt(analysis: JpqlAnalysis, offset: number): JpqlReference | undefined {
  return analysis.references.find(r => offset >= r.start && offset <= r.end);
}

// ---------------------------------------------------------------------------------------------- completion

export interface JpqlCompletion {
  label: string;
  kind: 'entity' | 'attribute' | 'association' | 'alias' | 'keyword' | 'function' | 'parameter';
  detail?: string;
  insertText?: string;
  /** Sort hint: lower comes first. */
  rank: number;
}

export interface CompletionResult {
  items: JpqlCompletion[];
  /** Range (query coordinates) the completion replaces. */
  replaceStart: number;
  replaceEnd: number;
}

const COMPLETION_KEYWORDS = [
  'SELECT', 'DISTINCT', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'JOIN FETCH', 'LEFT JOIN FETCH', 'ON', 'AND', 'OR', 'NOT', 'IN', 'IS NULL',
  'IS NOT NULL', 'IS EMPTY', 'MEMBER OF', 'LIKE', 'BETWEEN', 'EXISTS', 'GROUP BY', 'HAVING', 'ORDER BY', 'ASC', 'DESC', 'NEW', 'CASE',
  'WHEN', 'THEN', 'ELSE', 'END', 'UPDATE', 'SET', 'DELETE', 'TRUE', 'FALSE', 'NULL',
];
const FUNCTIONS = [
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'UPPER', 'LOWER', 'CONCAT', 'SUBSTRING', 'TRIM', 'LENGTH', 'LOCATE', 'ABS', 'SQRT', 'MOD',
  'SIZE', 'INDEX', 'COALESCE', 'NULLIF', 'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'TYPE', 'TREAT', 'KEY', 'VALUE',
];

export function completeJpql(q: string, offset: number, model: EntityModel, paramNames: string[] = []): CompletionResult {
  let wordStart = offset;
  while (wordStart > 0 && /[\p{L}\p{N}_$]/u.test(q[wordStart - 1])) {
    wordStart--;
  }
  const result: CompletionResult = { items: [], replaceStart: wordStart, replaceEnd: offset };
  const analysis = analyzeJpql(q, model, { checkEntities: false });
  const tokenIdx = analysis.tokens.findIndex(t => t.start >= wordStart);
  const at = tokenIdx < 0 ? analysis.tokens.length : tokenIdx;
  const scope = [...analysis.scopes].reverse().find(s => {
    const from = analysis.tokens[s.from]?.start ?? 0;
    const to = s.to < analysis.tokens.length ? analysis.tokens[s.to].start : q.length;
    return offset >= from && offset <= to;
  }) ?? analysis.scopes[0];
  const aliases: AliasInfo[] = [];
  for (let s: Scope | undefined = scope; s; s = s.parent) {
    aliases.push(...s.aliases.values());
  }

  // Parameter: ":na|"
  if (q[wordStart - 1] === ':') {
    result.replaceStart = wordStart;
    result.items = paramNames.map(n => ({ label: n, kind: 'parameter', detail: 'method parameter', rank: 0 }));
    return result;
  }

  // Path: "alias.attr.|"
  if (q[wordStart - 1] === '.') {
    const segs: string[] = [];
    let e = wordStart - 1;
    while (e > 0 && q[e] === '.') {
      let s = e;
      while (s > 0 && /[\p{L}\p{N}_$]/u.test(q[s - 1])) {
        s--;
      }
      if (s === e) {
        break;
      }
      segs.unshift(q.substring(s, e));
      e = s - 1;
    }
    const alias = aliases.find(a => a.name.toLowerCase() === segs[0]?.toLowerCase());
    let cur = alias?.type;
    for (const seg of segs.slice(1)) {
      const attr = cur?.attributes.get(seg);
      cur = attr ? model.target(attr) : undefined;
    }
    if (cur) {
      result.items = [...cur.attributes.values()].map(a => {
        const target = model.target(a);
        return {
          label: a.name,
          kind: target && target.kind === 'entity' ? 'association' : 'attribute',
          detail: `${a.type}${a.owner !== cur ? ` (from ${a.owner.name})` : ''}`,
          rank: a.collection ? 2 : target ? 1 : 0,
        } satisfies JpqlCompletion;
      });
    }
    return result;
  }

  const prev = analysis.tokens[at - 1];
  const prev2 = analysis.tokens[at - 2];
  const entityItems = (): JpqlCompletion[] => model.entities().map(e => ({
    label: e.entityName!, kind: 'entity', detail: e.fqn, rank: 0,
  }));
  const aliasItems = (rank: number): JpqlCompletion[] => aliases.map(a => ({
    label: a.name, kind: 'alias', detail: a.type ? `${a.type.entityName ?? a.type.name}` : undefined, rank,
  }));

  if (isKeyword(prev, 'FROM', 'UPDATE') || (prev?.text === ',' && isInFromList(analysis.tokens, at - 1))) {
    result.items = entityItems();
    return result;
  }
  if (isKeyword(prev, 'JOIN') || (isKeyword(prev, 'FETCH') && isKeyword(prev2, 'JOIN'))) {
    result.items = [...aliasItems(0).map(a => ({ ...a, insertText: `${a.label}.` })), ...entityItems().map(e => ({ ...e, rank: 1 }))];
    return result;
  }
  // After an entity in FROM/JOIN: suggest an alias name
  if (prev?.type === 'ident' && model.entity(prev.text) && (isKeyword(prev2, 'FROM', 'JOIN', 'FETCH', 'UPDATE') || prev2?.text === ',')) {
    const e = model.entity(prev.text)!;
    const suggestion = (e.entityName ?? e.name).charAt(0).toLowerCase();
    result.items = [{ label: suggestion, kind: 'alias', detail: 'alias', rank: 0 }];
    return result;
  }
  result.items = [
    ...aliasItems(0),
    ...COMPLETION_KEYWORDS.map(k => ({ label: k, kind: 'keyword' as const, rank: 2 })),
    ...FUNCTIONS.map(f => ({ label: f, kind: 'function' as const, insertText: /^CURRENT_/.test(f) ? f : `${f}(`, rank: 3 })),
  ];
  return result;
}

function isInFromList(tokens: JpqlToken[], commaIdx: number): boolean {
  for (let i = commaIdx - 1; i >= 0; i--) {
    if (isKeyword(tokens[i], 'FROM')) {
      return true;
    }
    if (isKeyword(tokens[i], 'SELECT', 'WHERE', 'ORDER', 'GROUP', 'JOIN', 'SET') || tokens[i].text === '(' || tokens[i].text === ')') {
      return false;
    }
  }
  return false;
}
