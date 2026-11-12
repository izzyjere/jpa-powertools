/**
 * Pure helpers that infer Java project settings from build files and sources.
 * File-system access lives in `projectScanner.ts`; this module only looks at strings.
 */

export interface BuildFacts {
  persistenceApi?: 'jakarta' | 'javax';
  lombok: boolean;
  springDataJpa: boolean;
}

/** Inspects a pom.xml / build.gradle(.kts) for persistence-related dependencies. */
export function analyzeBuildFile(content: string): BuildFacts {
  const lombok = /\blombok\b/.test(content);
  const springDataJpa = /spring-boot-starter-data-jpa|spring-data-jpa/.test(content);

  let persistenceApi: BuildFacts['persistenceApi'];
  if (/jakarta\.persistence/.test(content) || /hibernate-core[^]*?\b6\.|org\.hibernate\.orm/.test(content)) {
    persistenceApi = 'jakarta';
  } else if (/javax\.persistence/.test(content)) {
    persistenceApi = 'javax';
  }
  const bootVersion = springBootVersion(content);
  if (!persistenceApi && bootVersion !== undefined) {
    persistenceApi = bootVersion >= 3 ? 'jakarta' : 'javax';
  }
  return { persistenceApi, lombok, springDataJpa };
}

/** Major Spring Boot version declared in a Maven parent/BOM or Gradle plugin, if any. */
export function springBootVersion(content: string): number | undefined {
  const patterns = [
    // Maven parent or BOM: <artifactId>spring-boot-starter-parent</artifactId> <version>3.2.0</version>
    /<artifactId>spring-boot-(?:starter-parent|dependencies)<\/artifactId>\s*<version>\s*(\d+)\./,
    // Gradle plugins DSL: id 'org.springframework.boot' version '3.2.0'   /   id("org.springframework.boot") version "3.2.0"
    /org\.springframework\.boot['")\s]+version\s*['"(]*\s*['"](\d+)\./,
    // Gradle legacy: classpath("org.springframework.boot:spring-boot-gradle-plugin:2.7.0")
    /spring-boot-gradle-plugin:(\d+)\./,
    // Version catalog style or property: springBootVersion = '3.1.0'
    /spring[-_.]?boot[-_.]?version\s*[=:]\s*['"]?(\d+)\./i,
  ];
  for (const re of patterns) {
    const m = re.exec(content);
    if (m) {
      return Number(m[1]);
    }
  }
  return undefined;
}

/** Extracts the package declaration from a Java source file. */
export function packageOf(javaSource: string): string | undefined {
  const m = /^\s*package\s+([\w.]+)\s*;/m.exec(stripComments(javaSource));
  return m?.[1];
}

function stripComments(s: string): string {
  return s.replace(/\/\*[^]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

export function usesPersistenceApi(javaSource: string): 'jakarta' | 'javax' | undefined {
  if (/import\s+jakarta\.persistence\./.test(javaSource)) {
    return 'jakarta';
  }
  if (/import\s+javax\.persistence\./.test(javaSource)) {
    return 'javax';
  }
  return undefined;
}

const ENTITY_PACKAGE_NAMES = ['entity', 'entities', 'domain', 'model', 'models', 'persistence'];
const REPOSITORY_PACKAGE_NAMES = ['repository', 'repositories', 'repo', 'dao'];

/**
 * Picks entity and repository packages given the application's base package and
 * the packages that already exist in the project (preferring existing conventions).
 */
export function suggestPackages(basePackage: string, existingPackages: string[]): { entityPackage: string; repositoryPackage: string } {
  const prefix = basePackage ? basePackage + '.' : '';
  const pick = (candidates: string[], fallback: string) => {
    for (const c of candidates) {
      const hit = existingPackages.find(p => p === prefix + c || p.endsWith('.' + c) && p.startsWith(prefix));
      if (hit) {
        return hit;
      }
    }
    return prefix + fallback;
  };
  return {
    entityPackage: pick(ENTITY_PACKAGE_NAMES, 'entity'),
    repositoryPackage: pick(REPOSITORY_PACKAGE_NAMES, 'repository'),
  };
}

/** Longest common dot-separated prefix of a set of packages. */
export function commonPackage(packages: string[]): string {
  if (packages.length === 0) {
    return '';
  }
  const split = packages.map(p => p.split('.'));
  const out: string[] = [];
  for (let i = 0; ; i++) {
    const part = split[0][i];
    if (part === undefined || split.some(s => s[i] !== part)) {
      break;
    }
    out.push(part);
  }
  return out.join('.');
}
