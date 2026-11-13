/**
 * A small, forgiving Java source scanner: enough to find JPQL strings (with exact offset mapping back into
 * the document), repository methods and JPA entity declarations without a full Java parser.
 * Pure module: no `vscode` imports.
 */

export type JavaTokenType = 'ident' | 'string' | 'char' | 'number' | 'punct';

export interface JavaToken {
  type: JavaTokenType;
  text: string;
  start: number;
  end: number;
  /** For string tokens: the decoded value and, per decoded character, its offset in the source (+1 entry for the end). */
  value?: string;
  offsets?: number[];
}

/** A string assembled from one or more literals, with a source offset for every character. */
export interface MappedString {
  value: string;
  /** `offsets[i]` is the source offset of `value[i]`; `offsets[value.length]` is the end offset. */
  offsets: number[];
}

const PUNCT3 = ['>>>', '<<=', '>>=', '...'];
const PUNCT2 = ['==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '->', '::', '<<'];

export function tokenizeJava(src: string): JavaToken[] {
  const tokens: JavaToken[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f') {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') {
        i++;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '"' && src.startsWith('"""', i)) {
      const tok = readTextBlock(src, i);
      tokens.push(tok);
      i = tok.end;
      continue;
    }
    if (c === '"') {
      const tok = readString(src, i);
      tokens.push(tok);
      i = tok.end;
      continue;
    }
    if (c === '\'') {
      let j = i + 1;
      while (j < n && src[j] !== '\'' && src[j] !== '\n') {
        j += src[j] === '\\' ? 2 : 1;
      }
      tokens.push({ type: 'char', text: src.substring(i, j + 1), start: i, end: Math.min(j + 1, n) });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(src[j])) {
        j++;
      }
      tokens.push({ type: 'ident', text: src.substring(i, j), start: i, end: j });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j])) {
        j++;
      }
      tokens.push({ type: 'number', text: src.substring(i, j), start: i, end: j });
      i = j;
      continue;
    }
    const p3 = PUNCT3.find(p => src.startsWith(p, i));
    const p2 = p3 ? undefined : PUNCT2.find(p => src.startsWith(p, i));
    const p = p3 ?? p2 ?? c;
    tokens.push({ type: 'punct', text: p, start: i, end: i + p.length });
    i += p.length;
  }
  return tokens;
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', s: ' ', '"': '"', '\'': '\'', '\\': '\\' };

/** Decodes an escape at `src[i] === '\\'`; returns the decoded text (may be empty) and the next index. */
function decodeEscape(src: string, i: number): { text: string; next: number } {
  const e = src[i + 1];
  if (e === undefined) {
    return { text: '', next: i + 1 };
  }
  if (e === '\n') {
    return { text: '', next: i + 2 }; // text-block line continuation
  }
  if (e === '\r') {
    return { text: '', next: src[i + 2] === '\n' ? i + 3 : i + 2 };
  }
  if (e === 'u') {
    let j = i + 1;
    while (src[j] === 'u') {
      j++;
    }
    const hex = src.substring(j, j + 4);
    return /^[0-9a-fA-F]{4}$/.test(hex) ? { text: String.fromCharCode(parseInt(hex, 16)), next: j + 4 } : { text: 'u', next: i + 2 };
  }
  if (/[0-7]/.test(e)) {
    const m = /^[0-3]?[0-7]{1,2}/.exec(src.substring(i + 1, i + 4))!;
    return { text: String.fromCharCode(parseInt(m[0], 8)), next: i + 1 + m[0].length };
  }
  return { text: ESCAPES[e] ?? e, next: i + 2 };
}

function readString(src: string, start: number): JavaToken {
  let i = start + 1;
  let value = '';
  const offsets: number[] = [];
  while (i < src.length && src[i] !== '"' && src[i] !== '\n') {
    if (src[i] === '\\') {
      const { text, next } = decodeEscape(src, i);
      for (const ch of text) {
        value += ch;
        offsets.push(i);
      }
      i = next;
    } else {
      value += src[i];
      offsets.push(i);
      i++;
    }
  }
  offsets.push(i);
  const end = src[i] === '"' ? i + 1 : i;
  return { type: 'string', text: src.substring(start, end), start, end, value, offsets };
}

/** Java text block: strips incidental indentation and trailing spaces exactly like javac, keeping offsets. */
function readTextBlock(src: string, start: number): JavaToken {
  let i = start + 3;
  while (i < src.length && src[i] !== '\n') {
    i++; // the rest of the opening line must be blank
  }
  const contentStart = i + 1;
  const close = src.indexOf('"""', contentStart);
  const contentEnd = close < 0 ? src.length : close;
  const end = close < 0 ? src.length : close + 3;

  // Lines with their start offsets
  const lines: Array<{ start: number; text: string }> = [];
  let ls = contentStart;
  for (let j = contentStart; j <= contentEnd; j++) {
    if (j === contentEnd || src[j] === '\n') {
      let text = src.substring(ls, j);
      if (text.endsWith('\r')) {
        text = text.slice(0, -1);
      }
      lines.push({ start: ls, text });
      ls = j + 1;
    }
  }
  const lastIsClosing = lines.length > 0 && /^[ \t]*$/.test(lines[lines.length - 1].text);
  const significant = lines.filter((l, idx) => /\S/.test(l.text) || (idx === lines.length - 1 && lastIsClosing));
  const indent = significant.length ? Math.min(...significant.map(l => /^[ \t]*/.exec(l.text)![0].length)) : 0;

  let value = '';
  const offsets: number[] = [];
  lines.forEach((line, idx) => {
    const isLast = idx === lines.length - 1;
    if (isLast && lastIsClosing) {
      return;
    }
    const stripped = line.text.substring(Math.min(indent, line.text.length)).replace(/[ \t]+$/, '');
    const base = line.start + Math.min(indent, line.text.length);
    for (let k = 0; k < stripped.length; k++) {
      const abs = base + k;
      if (src[abs] === '\\') {
        const { text, next } = decodeEscape(src, abs);
        for (const ch of text) {
          value += ch;
          offsets.push(abs);
        }
        k += next - abs - 1;
      } else {
        value += src[abs];
        offsets.push(abs);
      }
    }
    if (!isLast) {
      value += '\n';
      offsets.push(line.start + line.text.length);
    }
  });
  offsets.push(contentEnd);
  return { type: 'string', text: src.substring(start, end), start, end, value, offsets };
}

/** Finds the index of the token closing the bracket opened at `open` (tokens[open] is `(`, `{`, `[` or `<`). */
export function matching(tokens: JavaToken[], open: number): number {
  const o = tokens[open].text;
  const c = o === '(' ? ')' : o === '{' ? '}' : o === '[' ? ']' : '>';
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    const t = tokens[i].text;
    if (tokens[i].type !== 'punct') {
      continue;
    }
    if (t === o) {
      depth++;
    } else if (t === c) {
      depth--;
      if (depth === 0) {
        return i;
      }
    } else if (o === '<' && t === '>>') {
      depth -= 2;
      if (depth <= 0) {
        return i;
      }
    } else if (o === '<' && (t === ';' || t === '{' || t === ')')) {
      return i - 1; // not a generic after all
    }
  }
  return tokens.length - 1;
}

/** Splits tokens[from, to) at top-level commas (respecting (), {}, [] and <> nesting). */
function splitTopLevel(tokens: JavaToken[], from: number, to: number): Array<[number, number]> {
  const parts: Array<[number, number]> = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i++) {
    const t = tokens[i];
    if (t.type !== 'punct') {
      continue;
    }
    if ('({[<'.includes(t.text)) {
      depth++;
    } else if (')}]>'.includes(t.text)) {
      depth--;
    } else if (t.text === '>>') {
      depth -= 2;
    } else if (t.text === ',' && depth === 0) {
      parts.push([start, i]);
      start = i + 1;
    }
  }
  if (start < to) {
    parts.push([start, to]);
  }
  return parts;
}

/** Concatenation of string literals (`"a " + "b"`); undefined when any operand is not a literal. */
function stringExpression(tokens: JavaToken[], from: number, to: number): MappedString | undefined {
  let value = '';
  const offsets: number[] = [];
  let expectString = true;
  for (let i = from; i < to; i++) {
    const t = tokens[i];
    if (expectString) {
      if (t.type !== 'string') {
        return undefined;
      }
      value += t.value!;
      offsets.push(...t.offsets!.slice(0, -1));
      expectString = false;
    } else {
      if (t.text !== '+') {
        return undefined;
      }
      expectString = true;
    }
  }
  if (expectString || from >= to) {
    return undefined;
  }
  const last = [...tokens.slice(from, to)].reverse().find(t => t.type === 'string')!;
  offsets.push(last.offsets![last.offsets!.length - 1]);
  return { value, offsets };
}

interface AnnotationArgs {
  /** name → token range of the value expression (`value` for the single unnamed argument). */
  args: Map<string, [number, number]>;
  end: number;
}

function annotationArgs(tokens: JavaToken[], openParen: number): AnnotationArgs {
  const close = matching(tokens, openParen);
  const args = new Map<string, [number, number]>();
  for (const [s, e] of splitTopLevel(tokens, openParen + 1, close)) {
    if (tokens[s]?.type === 'ident' && tokens[s + 1]?.text === '=') {
      args.set(tokens[s].text, [s + 2, e]);
    } else {
      args.set('value', [s, e]);
    }
  }
  return { args, end: close };
}

export interface MethodParam {
  name: string;
  type: string;
  /** Value of `@Param("…")`, if present. */
  paramAnnotation?: string;
  /** Source offset where the parameter declaration starts (for inserting annotations). */
  start: number;
}

export interface MethodSignature {
  name: string;
  nameStart: number;
  nameEnd: number;
  returnType: string;
  params: MethodParam[];
}

export interface JpqlQuery {
  source: 'query' | 'countQuery' | 'namedQuery' | 'createQuery';
  query: MappedString;
  /** The annotated repository method, for `@Query`. */
  method?: MethodSignature;
}

function typeText(tokens: JavaToken[], from: number, to: number): string {
  let out = '';
  for (let i = from; i < to; i++) {
    const t = tokens[i].text;
    out += (t === ',' ? ', ' : t);
  }
  return out;
}

/** Parses the method declaration that starts at or after `from` (skipping annotations and modifiers). */
export function parseMethodAfter(tokens: JavaToken[], from: number): { method: MethodSignature; end: number } | undefined {
  let i = from;
  const declStart = i;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.text === '@' && tokens[i + 1]?.type === 'ident') {
      i++;
      while (tokens[i + 1]?.text === '.' && tokens[i + 2]?.type === 'ident') {
        i += 2;
      }
      if (tokens[i + 1]?.text === '(') {
        i = matching(tokens, i + 1);
      }
      continue;
    }
    if (t.text === ';' || t.text === '{' || t.text === '}' || t.text === '=') {
      return undefined;
    }
    if (t.text === '<') {
      i = matching(tokens, i);
      continue;
    }
    if (t.text === '(' && tokens[i - 1]?.type === 'ident' && i - 1 > declStart) {
      const nameTok = tokens[i - 1];
      // return type: tokens between modifiers and name
      let rs = i - 2;
      let depth = 0;
      while (rs >= declStart) {
        const x = tokens[rs].text;
        if (x === '>' || x === '>>') {
          depth += x.length;
        } else if (x === '<') {
          depth--;
        } else if (depth === 0 && tokens[rs].type === 'ident' && /^(public|private|protected|static|final|abstract|default|synchronized|native)$/.test(x)) {
          break;
        } else if (depth === 0 && (x === ')' || x === '@')) {
          break;
        }
        rs--;
      }
      const returnType = typeText(tokens, rs + 1, i - 1);
      const close = matching(tokens, i);
      const params: MethodParam[] = [];
      for (const [s, e] of splitTopLevel(tokens, i + 1, close)) {
        let j = s;
        let paramAnnotation: string | undefined;
        while (tokens[j]?.text === '@') {
          const annName = tokens[j + 1]?.text;
          let k = j + 1;
          while (tokens[k + 1]?.text === '.' && tokens[k + 2]?.type === 'ident') {
            k += 2;
          }
          const lastName = tokens[k]?.text;
          if (tokens[k + 1]?.text === '(') {
            const { args, end } = annotationArgs(tokens, k + 1);
            if (lastName === 'Param' || annName === 'Param') {
              const v = args.get('value');
              const str = v && stringExpression(tokens, v[0], v[1]);
              paramAnnotation = str?.value;
            }
            j = end + 1;
          } else {
            j = k + 1;
          }
        }
        while (tokens[j]?.text === 'final') {
          j++;
        }
        const nameIdx = e - 1;
        if (nameIdx <= j || tokens[nameIdx].type !== 'ident') {
          continue;
        }
        params.push({ name: tokens[nameIdx].text, type: typeText(tokens, j, nameIdx), paramAnnotation, start: tokens[s].start });
      }
      return { method: { name: nameTok.text, nameStart: nameTok.start, nameEnd: nameTok.end, returnType, params }, end: close };
    }
  }
  return undefined;
}

function importsOf(tokens: JavaToken[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].text === 'import' && tokens[i].type === 'ident') {
      let j = i + 1;
      if (tokens[j]?.text === 'static') {
        j++;
      }
      let name = '';
      while (j < tokens.length && tokens[j].text !== ';') {
        name += tokens[j].text;
        j++;
      }
      out.push(name);
      i = j;
    }
  }
  return out;
}

/**
 * Finds JPQL strings in a Java source file: Spring Data JPA `@Query` (non-native, incl. `countQuery`),
 * `@NamedQuery(query = …)` and `createQuery(…)` calls. Strings built from non-literals are skipped.
 */
export function extractQueries(src: string, tokens = tokenizeJava(src)): JpqlQuery[] {
  const imports = importsOf(tokens);
  const springJpaQuery = imports.some(i => i === 'org.springframework.data.jpa.repository.Query' || i === 'org.springframework.data.jpa.repository.*');
  const out: JpqlQuery[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.text === '@' && tokens[i + 1]?.type === 'ident') {
      // Annotation name, possibly qualified
      let k = i + 1;
      let qualified = tokens[k].text;
      while (tokens[k + 1]?.text === '.' && tokens[k + 2]?.type === 'ident') {
        k += 2;
        qualified += '.' + tokens[k].text;
      }
      const simple = tokens[k].text;
      if (tokens[k + 1]?.text !== '(') {
        continue;
      }
      const isSpringQuery = simple === 'Query' && (qualified === 'org.springframework.data.jpa.repository.Query' || (qualified === 'Query' && springJpaQuery));
      if (isSpringQuery) {
        const { args, end } = annotationArgs(tokens, k + 1);
        const native = args.get('nativeQuery');
        if (native && tokens[native[0]]?.text === 'true') {
          i = end;
          continue;
        }
        const method = parseMethodAfter(tokens, end + 1)?.method;
        for (const key of ['value', 'countQuery'] as const) {
          const range = args.get(key);
          const query = range && stringExpression(tokens, range[0], range[1]);
          if (query) {
            out.push({ source: key === 'value' ? 'query' : 'countQuery', query, method });
          }
        }
        i = end;
      } else if (simple === 'NamedQuery') {
        const { args } = annotationArgs(tokens, k + 1);
        const range = args.get('query');
        const query = range && stringExpression(tokens, range[0], range[1]);
        if (query) {
          out.push({ source: 'namedQuery', query });
        }
        // keep scanning inside (nested annotations are not expected here)
      }
      continue;
    }
    if (t.type === 'ident' && t.text === 'createQuery' && tokens[i + 1]?.text === '(' && tokens[i - 1]?.text === '.') {
      const close = matching(tokens, i + 1);
      const [first] = splitTopLevel(tokens, i + 2, close);
      const query = first && stringExpression(tokens, first[0], first[1]);
      if (query) {
        out.push({ source: 'createQuery', query });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- entities

export interface AttributeDecl {
  name: string;
  /** Declared type text, e.g. `List<Order>` or `String`. */
  type: string;
  /** Simple name of the attribute's (element) type, e.g. `Order` for `List<Order>`. */
  elementType: string;
  collection: boolean;
  /** Fully qualified name of the element type when resolvable from imports/package. */
  elementTypeFqn?: string;
  offset: number;
  /** Annotations on the field: simple name → attribute → value (see {@link annotationMap}). */
  annotations?: AnnotationMap;
}

/**
 * Annotation values by simple annotation name and attribute name. String literals are decoded
 * (`@Column(name = "x")` → `x`); anything else is the raw source text (`GenerationType.IDENTITY`, `false`,
 * `{@JoinColumn(name = "a"), …}`). A marker annotation maps to an empty object.
 */
export type AnnotationMap = Record<string, Record<string, string>>;

function annotationMap(tokens: JavaToken[], annotations: Array<{ name: string; args?: AnnotationArgs }>): AnnotationMap {
  const out: AnnotationMap = {};
  for (const a of annotations) {
    const values: Record<string, string> = {};
    for (const [key, [s, e]] of a.args?.args ?? []) {
      const str = stringExpression(tokens, s, e);
      values[key] = str ? str.value : tokens.slice(s, e).reduce(
        (acc, t, i, arr) => acc + (i > 0 && /[\w"]$/.test(arr[i - 1].text) && /^[\w"@]/.test(t.text) ? ' ' : '') + t.text, '');
    }
    out[a.name] = values;
  }
  return out;
}

/** Reads `name = "…"` values of nested annotations in raw annotation text, e.g. `joinColumns = @JoinColumn(name = "a")`. */
export function nestedNames(raw: string | undefined): string[] {
  return raw ? [...raw.matchAll(/\bname\s*=\s*"([^"]*)"/g)].map(m => m[1]) : [];
}

export interface ClassDecl {
  name: string;
  packageName: string;
  kind: 'entity' | 'embeddable' | 'mappedSuperclass' | 'other';
  /** JPA entity name (`@Entity(name = …)` or the class name). */
  entityName?: string;
  superClass?: string;
  attributes: AttributeDecl[];
  offset: number;
  /** For interfaces extending a Spring Data repository: the domain type's simple name. */
  repositoryOf?: string;
  isInterface: boolean;
  bodyStart: number;
  bodyEnd: number;
  /** Class-level annotations (`@Table`, `@Inheritance`, …). */
  annotations?: AnnotationMap;
  isEnum?: boolean;
}

const COLLECTION_TYPES = new Set(['List', 'Set', 'Collection', 'SortedSet', 'Iterable', 'ArrayList', 'HashSet', 'LinkedHashSet', 'TreeSet', 'LinkedList']);
const MAP_TYPES = new Set(['Map', 'HashMap', 'LinkedHashMap', 'TreeMap', 'SortedMap']);
const REPOSITORY_TYPES = /^(Repository|CrudRepository|ListCrudRepository|PagingAndSortingRepository|ListPagingAndSortingRepository|JpaRepository|JpaRepositoryImplementation|RevisionRepository)$/;

function genericArgs(tokens: JavaToken[], open: number, close: number): string[][] {
  return splitTopLevel(tokens, open + 1, close).map(([s, e]) => tokens.slice(s, e).map(t => t.text));
}

function simpleTypeName(parts: string[]): string {
  const lt = parts.indexOf('<');
  const head = lt >= 0 ? parts.slice(0, lt) : parts;
  const idents = head.filter(p => /^[A-Za-z_$][\w$]*$/.test(p) && p !== 'extends' && p !== 'super' && p !== '?');
  return idents[idents.length - 1] ?? parts.join('');
}

/** Parses class-level JPA declarations from a Java source file. */
export function parseJavaClasses(src: string, tokens = tokenizeJava(src)): ClassDecl[] {
  const imports = importsOf(tokens);
  let packageName = '';
  if (tokens[0]?.text === 'package' || tokens.findIndex(t => t.text === 'package') >= 0) {
    const pi = tokens.findIndex(t => t.text === 'package' && t.type === 'ident');
    if (pi >= 0) {
      let j = pi + 1;
      while (j < tokens.length && tokens[j].text !== ';') {
        packageName += tokens[j].text;
        j++;
      }
    }
  }
  const resolveFqn = (simple: string): string | undefined => {
    const exact = imports.find(i => i.endsWith('.' + simple));
    if (exact) {
      return exact;
    }
    if (/^(String|Integer|Long|Short|Byte|Boolean|Double|Float|Character|Object|Number)$/.test(simple)) {
      return `java.lang.${simple}`;
    }
    return undefined;
  };

  const classes: ClassDecl[] = [];
  const parseTypeDecl = (i: number, annotations: Array<{ name: string; args?: AnnotationArgs }>): number => {
    const keyword = tokens[i].text;
    const nameTok = tokens[i + 1];
    if (!nameTok || nameTok.type !== 'ident') {
      return i + 1;
    }
    let j = i + 2;
    if (tokens[j]?.text === '<') {
      j = matching(tokens, j) + 1;
    }
    let superClass: string | undefined;
    let repositoryOf: string | undefined;
    // extends / implements / permits clauses up to the body
    while (j < tokens.length && tokens[j].text !== '{') {
      if (tokens[j].text === 'extends' || tokens[j].text === 'implements') {
        const isExtends = tokens[j].text === 'extends';
        let k = j + 1;
        // list of types
        while (k < tokens.length && tokens[k].text !== '{' && tokens[k].text !== 'implements' && tokens[k].text !== 'permits') {
          let typeName = '';
          while (tokens[k]?.type === 'ident' || tokens[k]?.text === '.') {
            typeName = tokens[k].type === 'ident' ? tokens[k].text : typeName;
            k++;
          }
          let args: string[][] = [];
          if (tokens[k]?.text === '<') {
            const close = matching(tokens, k);
            args = genericArgs(tokens, k, close);
            k = close + 1;
          }
          if (isExtends && keyword === 'class' && !superClass) {
            superClass = typeName;
          }
          if (REPOSITORY_TYPES.test(typeName) && args[0]) {
            repositoryOf = repositoryOf ?? simpleTypeName(args[0]);
          }
          if (tokens[k]?.text === ',') {
            k++;
          } else if (tokens[k]?.text !== '{' && tokens[k]?.text !== 'implements' && tokens[k]?.text !== 'permits') {
            k++;
          }
        }
        j = k;
      } else {
        j++;
      }
    }
    const bodyOpen = j;
    const bodyClose = bodyOpen < tokens.length ? matching(tokens, bodyOpen) : tokens.length - 1;
    const annNames = annotations.map(a => a.name);
    const kind: ClassDecl['kind'] = annNames.includes('Entity') ? 'entity'
      : annNames.includes('Embeddable') ? 'embeddable'
        : annNames.includes('MappedSuperclass') ? 'mappedSuperclass' : 'other';
    let entityName: string | undefined;
    if (kind === 'entity') {
      const ann = annotations.find(a => a.name === 'Entity');
      const nameArg = ann?.args?.args.get('name');
      entityName = (nameArg && stringExpression(tokens, nameArg[0], nameArg[1])?.value) || nameTok.text;
    }
    const decl: ClassDecl = {
      name: nameTok.text, packageName, kind, entityName, superClass, attributes: [], offset: nameTok.start,
      repositoryOf, isInterface: keyword === 'interface', bodyStart: tokens[bodyOpen]?.start ?? src.length, bodyEnd: tokens[bodyClose]?.end ?? src.length,
      annotations: annotationMap(tokens, annotations),
      isEnum: keyword === 'enum' || undefined,
    };
    classes.push(decl);
    if (keyword === 'class' || keyword === 'record') {
      parseMembers(bodyOpen + 1, bodyClose, decl);
    } else if (keyword === 'interface' || keyword === 'enum') {
      scanNested(bodyOpen + 1, bodyClose);
    }
    return bodyClose + 1;
  };

  const readAnnotation = (i: number): { name: string; args?: AnnotationArgs; next: number } => {
    let k = i + 1;
    while (tokens[k + 1]?.text === '.' && tokens[k + 2]?.type === 'ident') {
      k += 2;
    }
    const name = tokens[k]?.text ?? '';
    if (tokens[k + 1]?.text === '(') {
      const args = annotationArgs(tokens, k + 1);
      return { name, args, next: args.end + 1 };
    }
    return { name, next: k + 1 };
  };

  /** Finds nested type declarations in an interface/enum body (fields there are constants). */
  const scanNested = (from: number, to: number) => {
    let annotations: Array<{ name: string; args?: AnnotationArgs }> = [];
    for (let i = from; i < to; i++) {
      const t = tokens[i];
      if (t.text === '@' && tokens[i + 1]?.type === 'ident' && tokens[i + 1].text !== 'interface') {
        const a = readAnnotation(i);
        annotations.push(a);
        i = a.next - 1;
      } else if (t.type === 'ident' && /^(class|interface|enum|record)$/.test(t.text) && tokens[i - 1]?.text !== '.') {
        i = parseTypeDecl(i, annotations) - 1;
        annotations = [];
      } else if (t.text === '{') {
        i = matching(tokens, i);
        annotations = [];
      } else if (t.text === ';' || t.text === '}') {
        annotations = [];
      }
    }
  };

  const parseMembers = (from: number, to: number, decl: ClassDecl) => {
    let i = from;
    while (i < to) {
      // One member: annotations, modifiers, then a type/method/field/initializer
      const annotations: Array<{ name: string; args?: AnnotationArgs }> = [];
      const modifiers = new Set<string>();
      while (i < to) {
        if (tokens[i].text === '@' && tokens[i + 1]?.type === 'ident' && tokens[i + 1].text !== 'interface') {
          const a = readAnnotation(i);
          annotations.push(a);
          i = a.next;
        } else if (tokens[i].type === 'ident' && /^(public|private|protected|static|final|transient|volatile|abstract|synchronized|native|default|strictfp|sealed|non-sealed)$/.test(tokens[i].text)) {
          modifiers.add(tokens[i].text);
          i++;
        } else {
          break;
        }
      }
      if (i >= to) {
        break;
      }
      const t = tokens[i];
      if (t.text === ';') {
        i++;
        continue;
      }
      if (t.text === '{') {
        i = matching(tokens, i) + 1; // initializer block
        continue;
      }
      if (t.type === 'ident' && /^(class|interface|enum|record)$/.test(t.text)) {
        i = parseTypeDecl(i, annotations);
        continue;
      }
      // Field or method: scan to ';' or '(' or '=' at top level
      const start = i;
      let j = i;
      let isMethod = false;
      let eq = -1;
      while (j < to) {
        const x = tokens[j].text;
        if (x === '<') {
          j = matching(tokens, j) + 1;
          continue;
        }
        if (x === '(' && eq < 0) {
          isMethod = true;
          break;
        }
        if (x === '=' && eq < 0) {
          eq = j;
        }
        if (x === ';') {
          break;
        }
        if ((x === '{' || x === '(' || x === '[') && eq >= 0) {
          j = matching(tokens, j) + 1;
          continue;
        }
        j++;
      }
      if (isMethod) {
        const close = matching(tokens, j);
        let k = close + 1;
        while (k < to && tokens[k].text !== '{' && tokens[k].text !== ';') {
          k++;
        }
        i = tokens[k]?.text === '{' ? matching(tokens, k) + 1 : k + 1;
        continue;
      }
      const declEnd = eq >= 0 ? eq : j;
      const transientField = modifiers.has('static') || modifiers.has('transient') || annotations.some(a => a.name === 'Transient');
      // Multiple declarators (`int a, b;`) are rare in entities; take each identifier before a comma or the end.
      const typeEnd = (() => {
        let k = declEnd - 1;
        while (k > start && tokens[k].text === ']' && tokens[k - 1]?.text === '[') {
          k -= 2;
        }
        return k;
      })();
      const nameTok = tokens[typeEnd];
      if (!transientField && nameTok?.type === 'ident' && typeEnd > start) {
        const typeTokens = tokens.slice(start, typeEnd).map(x => x.text);
        const type = typeText(tokens, start, typeEnd);
        let elementType = simpleTypeName(typeTokens);
        let collection = false;
        const lt = typeTokens.indexOf('<');
        if (lt >= 0 && (COLLECTION_TYPES.has(elementType) || MAP_TYPES.has(elementType))) {
          const ltIdx = start + lt;
          const args = genericArgs(tokens, ltIdx, matching(tokens, ltIdx));
          const arg = MAP_TYPES.has(elementType) ? args[1] ?? args[0] : args[0];
          collection = true;
          elementType = arg ? simpleTypeName(arg) : 'Object';
        } else if (typeTokens.includes('[') && elementType !== 'byte' && elementType !== 'Byte' && elementType !== 'char') {
          collection = true;
        }
        const fqn = resolveFqn(elementType) ?? (packageName ? `${packageName}.${elementType}` : elementType);
        decl.attributes.push({
          name: nameTok.text, type, elementType, collection, elementTypeFqn: fqn, offset: nameTok.start,
          annotations: annotationMap(tokens, annotations),
        });
      }
      i = j + 1;
    }
  };

  // Top level
  let annotations: Array<{ name: string; args?: AnnotationArgs }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.text === '@' && tokens[i + 1]?.type === 'ident' && tokens[i + 1].text !== 'interface') {
      const a = readAnnotation(i);
      annotations.push(a);
      i = a.next - 1;
    } else if (t.type === 'ident' && /^(class|interface|enum|record)$/.test(t.text) && tokens[i - 1]?.text !== '.') {
      i = parseTypeDecl(i, annotations) - 1;
      annotations = [];
    } else if (t.text === ';') {
      annotations = [];
    }
  }
  return classes;
}

/** Repository methods declared in a Spring Data repository interface. */
export interface RepositoryMethod extends MethodSignature {
  /** Simple name of the repository's domain type. */
  domainType: string;
  /** Offset of the first token of the declaration (annotations included). */
  declStart: number;
  annotations: string[];
}

export function repositoryMethods(src: string, tokens = tokenizeJava(src)): RepositoryMethod[] {
  const out: RepositoryMethod[] = [];
  for (const cls of parseJavaClasses(src, tokens)) {
    if (!cls.isInterface || !cls.repositoryOf) {
      continue;
    }
    let i = tokens.findIndex(t => t.start === cls.bodyStart) + 1;
    const endIdx = tokens.findIndex(t => t.start >= cls.bodyEnd - 1);
    while (i > 0 && i < endIdx) {
      const declStart = tokens[i].start;
      const annotations: string[] = [];
      let k = i;
      while (tokens[k]?.text === '@' && tokens[k + 1]?.type === 'ident') {
        let a = k + 1;
        while (tokens[a + 1]?.text === '.' && tokens[a + 2]?.type === 'ident') {
          a += 2;
        }
        annotations.push(tokens[a].text);
        k = tokens[a + 1]?.text === '(' ? matching(tokens, a + 1) + 1 : a + 1;
      }
      const parsed = parseMethodAfter(tokens, i);
      if (!parsed) {
        // skip to the next statement
        while (i < endIdx && tokens[i].text !== ';' && tokens[i].text !== '}') {
          i = tokens[i].text === '{' ? matching(tokens, i) + 1 : i + 1;
        }
        i++;
        continue;
      }
      out.push({ ...parsed.method, domainType: cls.repositoryOf, declStart, annotations });
      let e = parsed.end + 1;
      while (e < endIdx && tokens[e].text !== ';' && tokens[e].text !== '{') {
        e++;
      }
      i = tokens[e]?.text === '{' ? matching(tokens, e) + 1 : e + 1;
    }
  }
  return out;
}
