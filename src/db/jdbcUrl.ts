import { DbKind, defaultPort, dialect } from '../model/types';

export interface ParsedJdbcUrl {
  kind: DbKind;
  host: string;
  port: number;
  database: string;
  ssl: boolean;
  user?: string;
  password?: string;
  /** For URL-only and file dialects (H2, HSQLDB, SQLite, generic JDBC): the original URL. */
  jdbcUrl?: string;
}

const NETWORK_PREFIXES: Array<[string, DbKind]> = [
  ['jdbc:postgresql:', 'postgresql'],
  ['jdbc:mysql:', 'mysql'],
  ['jdbc:mariadb:', 'mariadb'],
  ['jdbc:db2:', 'db2'],
  ['jdbc:derby:', 'derby'],
  ['jdbc:firebirdsql:', 'firebird'],
  ['jdbc:firebird:', 'firebird'],
  ['postgresql:', 'postgresql'],
  ['postgres:', 'postgresql'],
  ['mysql:', 'mysql'],
  ['mariadb:', 'mariadb'],
];

const URL_ONLY: Array<[string, DbKind]> = [
  ['jdbc:h2:', 'h2'],
  ['jdbc:hsqldb:', 'hsqldb'],
  ['jdbc:sqlite:', 'sqlite'],
];

/**
 * Parses JDBC URLs for every supported database, plus plain driver URLs (`postgres://user:pass@host/db`).
 * Unknown `jdbc:` URLs are returned as generic JDBC. Returns `undefined` for anything that is not a URL.
 */
export function parseJdbcUrl(input: string): ParsedJdbcUrl | undefined {
  const url = input.trim();
  const lower = url.toLowerCase();

  if (lower.startsWith('jdbc:sqlserver:')) {
    return parseSqlServer(url);
  }
  if (lower.startsWith('jdbc:oracle:')) {
    return parseOracle(url);
  }
  const urlOnly = URL_ONLY.find(([p]) => lower.startsWith(p));
  if (urlOnly) {
    return { ...urlOnlyDefaults(urlOnly[1]), jdbcUrl: url, database: urlOnly[1] === 'sqlite' ? url.substring('jdbc:sqlite:'.length) : '' };
  }
  const prefix = NETWORK_PREFIXES.find(([p]) => lower.startsWith(p));
  if (!prefix) {
    return /^jdbc:[a-z0-9][a-z0-9-]*:/i.test(url) ? { ...urlOnlyDefaults('jdbc'), database: '', jdbcUrl: url } : undefined;
  }
  return parseHostUrl(url.substring(prefix[0].length), prefix[1]);
}

function urlOnlyDefaults(kind: DbKind): ParsedJdbcUrl {
  return { kind, host: '', port: defaultPort(kind), database: '', ssl: false };
}

function parseHostUrl(rest: string, kind: DbKind): ParsedJdbcUrl | undefined {
  // MySQL Connector/J allows sub-protocols such as jdbc:mysql:loadbalance://
  const subProto = /^[a-z:+]*?(?=\/\/)/i.exec(rest);
  if (subProto) {
    rest = rest.substring(subProto[0].length);
  }
  if (!rest.startsWith('//')) {
    // e.g. "jdbc:postgresql:mydb" (host defaults to localhost)
    if (kind === 'postgresql' && /^[^/?]+$/.test(rest.split('?')[0])) {
      const [db, query] = rest.split('?');
      return { kind, host: 'localhost', port: defaultPort(kind), database: safeDecode(db), ssl: sslFromQuery(query) };
    }
    return undefined;
  }
  rest = rest.substring(2);

  // Query: "?a=b&c=d" (most drivers), ":a=b;c=d;" (Db2), ";a=b" (Derby)
  let query = '';
  const queryIdx = rest.search(kind === 'db2' ? /[?]|:(?=[^/]*=)/ : kind === 'derby' ? /[?;]/ : /\?/);
  if (queryIdx >= 0) {
    query = rest.substring(queryIdx + 1);
    rest = rest.substring(0, queryIdx);
  }
  const slash = rest.indexOf('/');
  let authority = slash >= 0 ? rest.substring(0, slash) : rest;
  const database = slash >= 0 ? safeDecode(rest.substring(slash + 1).replace(/\/+$/, '')) : '';

  let user: string | undefined;
  let password: string | undefined;
  const at = authority.lastIndexOf('@');
  if (at >= 0) {
    const cred = authority.substring(0, at);
    authority = authority.substring(at + 1);
    const colon = cred.indexOf(':');
    user = safeDecode(colon >= 0 ? cred.substring(0, colon) : cred);
    password = colon >= 0 ? safeDecode(cred.substring(colon + 1)) : undefined;
  }
  // Only the first host of a multi-host/failover URL is used.
  authority = authority.split(',')[0];

  const hp = splitHostPort(authority, defaultPort(kind));
  if (!hp) {
    return undefined;
  }
  const params = queryParams(query);
  user = user ?? params.get('user') ?? undefined;
  password = password ?? params.get('password') ?? undefined;
  return { kind, host: hp.host || 'localhost', port: hp.port, database, ssl: sslFromQuery(query), user, password };
}

function splitHostPort(authority: string, fallbackPort: number): { host: string; port: number } | undefined {
  const ipv6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(authority);
  if (ipv6) {
    return { host: ipv6[1], port: ipv6[2] ? Number(ipv6[2]) : fallbackPort };
  }
  const colon = authority.lastIndexOf(':');
  if (colon < 0) {
    return { host: authority, port: fallbackPort };
  }
  const portStr = authority.substring(colon + 1);
  if (!/^\d+$/.test(portStr)) {
    return undefined;
  }
  return { host: authority.substring(0, colon), port: Number(portStr) };
}

/** jdbc:sqlserver://host[\instance][:port][;property=value]* */
function parseSqlServer(url: string): ParsedJdbcUrl | undefined {
  const rest = url.substring('jdbc:sqlserver:'.length);
  if (!rest.startsWith('//')) {
    return undefined;
  }
  const [server, ...props] = rest.substring(2).split(';');
  const params = new Map<string, string>();
  for (const p of props) {
    const eq = p.indexOf('=');
    if (eq > 0) {
      params.set(p.substring(0, eq).trim().toLowerCase(), p.substring(eq + 1).trim());
    }
  }
  let host = server;
  let instance = params.get('instancename');
  const port = params.get('portnumber') ?? params.get('port');
  let portNum = port && /^\d+$/.test(port) ? Number(port) : defaultPort('sqlserver');
  const hostPort = /^(.*?):(\d+)$/.exec(host);
  if (hostPort) {
    host = hostPort[1];
    portNum = Number(hostPort[2]);
  }
  const bs = host.indexOf('\\');
  if (bs >= 0) {
    instance = instance ?? host.substring(bs + 1);
    host = host.substring(0, bs);
  }
  host = host || params.get('servername') || 'localhost';
  return {
    kind: 'sqlserver',
    host: instance ? `${host}\\${instance}` : host,
    port: portNum,
    database: params.get('databasename') ?? params.get('database') ?? '',
    ssl: /^(true|strict|mandatory)$/i.test(params.get('encrypt') ?? ''),
    user: params.get('user') ?? params.get('username'),
    password: params.get('password'),
  };
}

/**
 * jdbc:oracle:thin:@//host:port/service, jdbc:oracle:thin:@host:port:SID, jdbc:oracle:thin:@host:port/service,
 * jdbc:oracle:thin:user/pass@host:port/service, jdbc:oracle:thin:@tcps://host:port/service
 */
function parseOracle(url: string): ParsedJdbcUrl | undefined {
  const m = /^jdbc:oracle:(?:thin|oci):(?:([^/@]*)(?:\/([^@]*))?)?@(.*)$/i.exec(url);
  if (!m) {
    return undefined;
  }
  const [, user, password] = m;
  let target = m[3].trim();
  if (target.startsWith('(')) {
    // Full connect descriptor; keep it whole as the "service name".
    const host = /HOST\s*=\s*([^)\s]+)/i.exec(target)?.[1] ?? 'localhost';
    const port = Number(/PORT\s*=\s*(\d+)/i.exec(target)?.[1] ?? defaultPort('oracle'));
    return { kind: 'oracle', host, port, database: target, ssl: /PROTOCOL\s*=\s*TCPS/i.test(target), user: user || undefined, password };
  }
  let ssl = false;
  const proto = /^(tcps?):\/\//i.exec(target);
  if (proto) {
    ssl = proto[1].toLowerCase() === 'tcps';
    target = target.substring(proto[0].length);
  }
  target = target.replace(/^\/\//, '').replace(/\?.*$/, '');
  const sm = /^([^:/]+)(?::(\d+))?(?:[/:](.+))?$/.exec(target);
  if (!sm) {
    return undefined;
  }
  return {
    kind: 'oracle',
    host: sm[1],
    port: sm[2] ? Number(sm[2]) : defaultPort('oracle'),
    database: sm[3] ?? '',
    ssl,
    user: user || undefined,
    password,
  };
}

function queryParams(query: string): URLSearchParams {
  return new URLSearchParams(query.replace(/;/g, '&').replace(/:(?=[^=&]*=)/g, '&'));
}

function sslFromQuery(query: string | undefined): boolean {
  if (!query) {
    return false;
  }
  const params = queryParams(query);
  const get = (k: string) => {
    for (const [key, v] of params) {
      if (key.toLowerCase() === k.toLowerCase()) {
        return v;
      }
    }
    return null;
  };
  const truthy = (v: string | null) => v !== null && /^(true|1|yes)$/i.test(v);
  const mode = (get('sslmode') ?? '').toLowerCase();
  if (mode) {
    return !['disable', 'disabled', 'allow', 'prefer', 'preferred'].includes(mode);
  }
  return truthy(get('ssl')) || truthy(get('useSSL')) || truthy(get('requireSSL')) || truthy(get('sslConnection'));
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Builds the JDBC URL the application (or the JDBC bridge) would use for a connection. */
export function buildJdbcUrl(c: { kind: DbKind; host: string; port: number; database: string; ssl: boolean; jdbcUrl?: string }): string {
  const d = dialect(c.kind);
  if (d.target === 'url' || (c.jdbcUrl && d.driver === 'jdbc')) {
    return c.jdbcUrl ?? '';
  }
  if (c.kind === 'sqlite') {
    return `jdbc:sqlite:${c.database}`;
  }
  const host = c.host.includes(':') && !c.host.startsWith('[') ? `[${c.host}]` : c.host;
  switch (c.kind) {
    case 'sqlserver': {
      const props = [c.database ? `databaseName=${c.database}` : '', `encrypt=${c.ssl}`, c.ssl ? 'trustServerCertificate=true' : '']
        .filter(Boolean).join(';');
      const named = c.host.includes('\\');
      return `jdbc:sqlserver://${c.host}${named ? '' : `:${c.port}`};${props}`;
    }
    case 'oracle':
      return c.database.startsWith('(')
        ? `jdbc:oracle:thin:@${c.database}`
        : `jdbc:oracle:thin:@${c.ssl ? 'tcps://' : '//'}${host}:${c.port}/${c.database}`;
    case 'db2':
      return `jdbc:db2://${host}:${c.port}/${c.database}${c.ssl ? ':sslConnection=true;' : ''}`;
    case 'derby':
      return `jdbc:derby://${host}:${c.port}/${c.database}${c.ssl ? ';ssl=basic' : ''}`;
    case 'firebird':
      return `jdbc:firebirdsql://${host}:${c.port}/${c.database}`;
    default: {
      const base = `jdbc:${c.kind}://${host}:${c.port}/${c.database ? encodeURIComponent(c.database) : ''}`;
      if (!c.ssl) {
        return base;
      }
      return c.kind === 'postgresql' ? `${base}?sslmode=require` : `${base}?sslMode=REQUIRED`;
    }
  }
}
