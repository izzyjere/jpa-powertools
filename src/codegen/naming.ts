/** Identifier helpers for turning SQL names into idiomatic Java names. */

export const JAVA_KEYWORDS = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const', 'continue',
  'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'goto', 'if',
  'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new', 'package', 'private',
  'protected', 'public', 'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this',
  'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while', 'true', 'false', 'null', 'var', 'record',
  'yield', 'sealed', 'permits', '_',
]);

/** Splits `order_line`, `OrderLine`, `orderLINE-item 2` into lower-case words. */
export function splitWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(w => w.toLowerCase());
}

const capitalize = (w: string) => (w ? w[0].toUpperCase() + w.substring(1) : w);

export function toPascalCase(name: string): string {
  return splitWords(name).map(capitalize).join('');
}

export function toCamelCase(name: string): string {
  const pascal = toPascalCase(name);
  return pascal ? pascal[0].toLowerCase() + pascal.substring(1) : pascal;
}

/** Makes a string a legal, non-keyword Java identifier. */
export function safeIdentifier(id: string, fallback = 'field'): string {
  let out = id.replace(/[^A-Za-z0-9_$]/g, '');
  if (!out) {
    out = fallback;
  }
  if (/^[0-9]/.test(out)) {
    out = '_' + out;
  }
  if (JAVA_KEYWORDS.has(out)) {
    out = out === 'class' ? 'clazz' : out + 'Value';
  }
  return out;
}

const IRREGULAR_SINGULAR: Record<string, string> = {
  people: 'person', children: 'child', men: 'man', women: 'woman', mice: 'mouse', geese: 'goose',
  teeth: 'tooth', feet: 'foot', data: 'data', media: 'media', criteria: 'criterion', indices: 'index',
  matrices: 'matrix', vertices: 'vertex', analyses: 'analysis', statuses: 'status', aliases: 'alias',
  news: 'news', series: 'series', species: 'species', movies: 'movie', cookies: 'cookie', buses: 'bus',
  caches: 'cache', niches: 'niche', ties: 'tie', pies: 'pie', lies: 'lie',
};
const IRREGULAR_PLURAL: Record<string, string> = Object.fromEntries(
  Object.entries(IRREGULAR_SINGULAR).filter(([p, s]) => p !== s).map(([p, s]) => [s, p]),
);
const UNCOUNTABLE = new Set(['data', 'media', 'news', 'series', 'species', 'equipment', 'information', 'metadata', 'audit', 'staff']);

/** Lightweight English singularization tuned for table names (`categories` → `category`). */
export function singularize(word: string): string {
  const lower = word.toLowerCase();
  if (UNCOUNTABLE.has(lower)) {
    return word;
  }
  if (IRREGULAR_SINGULAR[lower]) {
    return matchCase(word, IRREGULAR_SINGULAR[lower]);
  }
  if (/[^aeiou]ies$/i.test(word)) {
    return word.slice(0, -3) + matchCase(word.slice(-3), 'y');
  }
  if (/(ss|x|zz|ch|sh)es$/i.test(word)) {
    return word.slice(0, -2);
  }
  if (/(ss|us|is)$/i.test(word)) {
    return word;
  }
  if (/s$/i.test(word) && word.length > 1) {
    return word.slice(0, -1);
  }
  return word;
}

export function pluralize(word: string): string {
  const lower = word.toLowerCase();
  if (UNCOUNTABLE.has(lower)) {
    return word;
  }
  if (IRREGULAR_PLURAL[lower]) {
    return matchCase(word, IRREGULAR_PLURAL[lower]);
  }
  if (/[^aeiou]y$/i.test(word)) {
    return word.slice(0, -1) + matchCase(word.slice(-1), 'ies');
  }
  if (/(s|x|z|ch|sh)$/i.test(word)) {
    return word + matchCase(word.slice(-1), 'es');
  }
  return word + matchCase(word.slice(-1), 's');
}

function matchCase(sample: string, replacement: string): string {
  return sample === sample.toUpperCase() && /[A-Z]/.test(sample) ? replacement.toUpperCase() : replacement;
}

/**
 * Derives an entity class name from a table name: strips configured prefixes,
 * singularizes the last word and converts to PascalCase (`tbl_order_items` → `OrderItem`).
 */
export function tableToClassName(table: string, stripPrefixes: string[] = []): string {
  let name = table;
  for (const prefix of stripPrefixes.map(p => p.trim()).filter(Boolean)) {
    if (name.toLowerCase().startsWith(prefix.toLowerCase()) && name.length > prefix.length) {
      name = name.substring(prefix.length);
      break;
    }
  }
  const words = splitWords(name);
  if (words.length === 0) {
    return 'Entity';
  }
  words[words.length - 1] = singularize(words[words.length - 1]);
  const cls = words.map(capitalize).join('');
  return /^[0-9]/.test(cls) ? 'T' + cls : JAVA_KEYWORDS.has(cls.toLowerCase()) && cls === cls.toLowerCase() ? cls + 'Entity' : cls;
}

export function columnToFieldName(column: string): string {
  return safeIdentifier(toCamelCase(column));
}

/** Returns `base`, or `base2`, `base3`… so that the result is not in `taken`. Adds the result to `taken`. */
export function uniqueName(base: string, taken: Set<string>): string {
  let name = base;
  let i = 2;
  while (taken.has(name)) {
    name = `${base}${i++}`;
  }
  taken.add(name);
  return name;
}

const JAVA_PACKAGE_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*(\.[a-zA-Z_$][a-zA-Z0-9_$]*)*$/;

/** Returns an error message for an invalid Java package name, or `undefined` if valid. Empty = default package. */
export function validatePackageName(pkg: string): string | undefined {
  if (pkg === '') {
    return undefined;
  }
  if (!JAVA_PACKAGE_RE.test(pkg)) {
    return 'Use dot-separated Java identifiers, e.g. com.example.domain';
  }
  const bad = pkg.split('.').find(p => JAVA_KEYWORDS.has(p));
  return bad ? `"${bad}" is a reserved Java keyword` : undefined;
}

/** Escapes a value for use inside a Java string literal. */
export function javaString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n') + '"';
}
