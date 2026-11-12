import { parseAllDocuments } from 'yaml';
import { parseJdbcUrl, ParsedJdbcUrl } from '../db/jdbcUrl';

export interface SpringDatasource extends ParsedJdbcUrl {
  /** The raw (placeholder-resolved) JDBC URL. */
  url: string;
  /** Spring profile, e.g. `dev` for application-dev.yml; empty for the default file. */
  profile: string;
}

/** Resolves `${ENV:default}` placeholders to their default (or empty if none). */
export function resolvePlaceholders(value: string): string {
  let out = value;
  // Resolve innermost placeholders first so nested defaults work: ${A:${B:x}}
  for (let i = 0; i < 10 && /\$\{[^{}]*\}/.test(out); i++) {
    out = out.replace(/\$\{([^{}]*)\}/g, (_, expr: string) => {
      const idx = expr.indexOf(':');
      return idx >= 0 ? expr.substring(idx + 1) : '';
    });
  }
  return out;
}

/** Parses Java `.properties` content into a flat key → value map (handles continuations and escapes). */
export function parseProperties(content: string): Map<string, string> {
  const result = new Map<string, string>();
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/^\s+/, '');
    if (!line || line.startsWith('#') || line.startsWith('!')) {
      continue;
    }
    while (/(^|[^\\])(\\\\)*\\$/.test(line) && i + 1 < lines.length) {
      line = line.slice(0, -1) + lines[++i].replace(/^\s+/, '');
    }
    const m = /^((?:\\.|[^=:\s\\])+)\s*[=:\s]\s*(.*)$/.exec(line);
    if (!m) {
      result.set(unescape(line), '');
      continue;
    }
    result.set(unescape(m[1]), unescape(m[2]));
  }
  return result;
}

function unescape(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c: string) => {
    if (c.length === 5) {
      return String.fromCharCode(parseInt(c.substring(1), 16));
    }
    return ({ n: '\n', t: '\t', r: '\r', f: '\f' } as Record<string, string>)[c] ?? c;
  });
}

/** Flattens YAML documents into dotted keys (`spring.datasource.url`). Later documents override earlier ones. */
export function flattenYaml(content: string): Map<string, string> {
  const result = new Map<string, string>();
  const walk = (node: unknown, prefix: string) => {
    if (node === null || node === undefined) {
      return;
    }
    if (typeof node === 'object' && !Array.isArray(node)) {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        walk(v, prefix ? `${prefix}.${k}` : k);
      }
    } else if (!Array.isArray(node)) {
      result.set(prefix, String(node));
    }
  };
  for (const doc of parseAllDocuments(content)) {
    if ('errors' in doc && doc.errors.length === 0) {
      walk(doc.toJS(), '');
    }
  }
  return result;
}

/** Relaxed binding: `spring.datasource.jdbc-url`, `SPRING_DATASOURCE_URL`, `spring.datasource.jdbcUrl` … */
function lookup(props: Map<string, string>, ...keys: string[]): string | undefined {
  const norm = (k: string) => k.toLowerCase().replace(/[-_.]/g, '');
  const wanted = new Set(keys.map(norm));
  for (const [k, v] of props) {
    if (wanted.has(norm(k))) {
      return v;
    }
  }
  return undefined;
}

/** Extracts a datasource from a Spring Boot config file, or `undefined` if none or unsupported. */
export function extractDatasource(fileName: string, content: string): SpringDatasource | undefined {
  let props: Map<string, string>;
  try {
    props = /\.ya?ml$/i.test(fileName) ? flattenYaml(content) : parseProperties(content);
  } catch {
    return undefined;
  }
  const rawUrl = lookup(props, 'spring.datasource.url', 'spring.datasource.jdbc-url', 'spring.datasource.hikari.jdbc-url', 'spring.flyway.url', 'spring.liquibase.url');
  if (!rawUrl) {
    return undefined;
  }
  const url = resolvePlaceholders(rawUrl);
  const parsed = parseJdbcUrl(url);
  if (!parsed) {
    return undefined;
  }
  const user = lookup(props, 'spring.datasource.username', 'spring.datasource.hikari.username');
  const password = lookup(props, 'spring.datasource.password', 'spring.datasource.hikari.password');
  const base = fileName.replace(/^.*[\\/]/, '');
  const profile = /^application-(.+)\.(properties|ya?ml)$/i.exec(base)?.[1] ?? '';
  return {
    ...parsed,
    url,
    user: user !== undefined ? resolvePlaceholders(user) : parsed.user,
    password: password !== undefined ? resolvePlaceholders(password) : parsed.password,
    profile,
  };
}
