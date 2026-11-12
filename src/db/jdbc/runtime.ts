import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { MavenArtifact } from '../../model/types';

/** Everything needed to start the JDBC bridge process. */
export interface JdbcRuntime {
  javaPath: string;
  classpath: string[];
  bridgeSource: string;
}

const MAVEN_CENTRAL = 'https://repo1.maven.org/maven2';

export function mavenJarUrl(a: MavenArtifact): string {
  return `${MAVEN_CENTRAL}/${a.group.replace(/\./g, '/')}/${a.artifact}/${a.version}/${a.artifact}-${a.version}.jar`;
}

export function jarFileName(a: MavenArtifact): string {
  return `${a.artifact}-${a.version}.jar`;
}

/** Parses the major version from `java -version` output (`1.8.0_392` → 8, `21.0.2` → 21). */
export function parseJavaMajor(versionOutput: string): number | undefined {
  const m = /version "(\d+)(?:\.(\d+))?[^"]*"/.exec(versionOutput) ?? /^(?:openjdk|java) (\d+)(?:\.(\d+))?/m.exec(versionOutput);
  if (!m) {
    return undefined;
  }
  const major = Number(m[1]);
  return major === 1 && m[2] ? Number(m[2]) : major;
}

export const MIN_JAVA = 11;

export class JavaNotFoundError extends Error {}

/** Locates a Java 11+ executable: explicit home → JAVA_HOME → PATH. */
export async function findJava(configuredHome?: string): Promise<string> {
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  const candidates: string[] = [];
  if (configuredHome) {
    candidates.push(path.join(configuredHome, 'bin', exe));
  }
  if (process.env.JAVA_HOME) {
    candidates.push(path.join(process.env.JAVA_HOME, 'bin', exe));
  }
  candidates.push('java');
  let lastProblem = '';
  for (const c of candidates) {
    if (c !== 'java' && !fs.existsSync(c)) {
      continue;
    }
    const out = await new Promise<string | undefined>(resolve => {
      execFile(c, ['-version'], { timeout: 15_000, windowsHide: true }, (err, stdout, stderr) => {
        resolve(err && !stderr ? undefined : `${stdout}${stderr}`);
      });
    });
    if (out === undefined) {
      continue;
    }
    const major = parseJavaMajor(out);
    if (major !== undefined && major >= MIN_JAVA) {
      return c;
    }
    lastProblem = `Found Java ${major ?? '(unknown version)'} at ${c}, but Java ${MIN_JAVA} or newer is required.`;
  }
  throw new JavaNotFoundError(
    lastProblem || `Java ${MIN_JAVA}+ was not found. Install a JDK/JRE, set JAVA_HOME, or set "jpaPowertools.javaHome".`,
  );
}

function get(url: string, redirects = 5): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30_000, headers: { 'User-Agent': 'jpa-powertools-vscode' } }, res => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(get(new URL(res.headers.location, url).toString(), redirects - 1));
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`HTTP ${status} downloading ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`Timed out downloading ${url}`)));
    req.on('error', reject);
  });
}

/**
 * Downloads a Maven artifact into `dir` and verifies it against the published SHA-1.
 * Returns the jar path. Existing files are reused.
 */
export async function downloadArtifact(a: MavenArtifact, dir: string, fetch: (url: string) => Promise<Buffer> = get): Promise<string> {
  const target = path.join(dir, jarFileName(a));
  if (fs.existsSync(target)) {
    return target;
  }
  const url = mavenJarUrl(a);
  const [jar, sha] = await Promise.all([fetch(url), fetch(url + '.sha1')]);
  const expected = sha.toString('utf8').trim().split(/\s+/)[0].toLowerCase();
  const actual = createHash('sha1').update(jar).digest('hex');
  if (expected !== actual) {
    throw new Error(`Checksum mismatch for ${jarFileName(a)} (expected ${expected}, got ${actual}).`);
  }
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, jar);
  await fs.promises.rename(tmp, target);
  return target;
}

export function missingArtifacts(artifacts: MavenArtifact[], dir: string): MavenArtifact[] {
  return artifacts.filter(a => !fs.existsSync(path.join(dir, jarFileName(a))));
}
