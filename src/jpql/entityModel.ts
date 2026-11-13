import { AnnotationMap, AttributeDecl, ClassDecl } from './javaSource';

export interface ModelAttribute extends AttributeDecl {
  /** Class that declares the attribute (may be a mapped superclass). */
  owner: ModelClass;
}

export interface ModelClass {
  name: string;
  fqn: string;
  kind: ClassDecl['kind'];
  entityName?: string;
  file: string;
  offset: number;
  /** Own and inherited persistent attributes. */
  attributes: Map<string, ModelAttribute>;
  /** True when a superclass is outside the workspace, so inherited attributes are unknown. */
  incomplete: boolean;
  /** Class-level annotations, e.g. `@Table(name = …)`. */
  annotations: AnnotationMap;
}

/** Types that are definitely basic (not navigable) in JPQL paths. */
const BASIC = /^(String|Integer|int|Long|long|Short|short|Byte|byte|Boolean|boolean|Double|double|Float|float|Character|char|BigDecimal|BigInteger|UUID|LocalDate|LocalTime|LocalDateTime|OffsetDateTime|OffsetTime|ZonedDateTime|Instant|Duration|Period|Year|YearMonth|MonthDay|Date|Calendar|Timestamp|Time|Blob|Clob|Locale|Currency|URL|URI|Object|ZoneId|TimeZone|Class)$/;

export function isBasicTypeName(simple: string): boolean {
  return BASIC.test(simple);
}

/** The JPA classes of a workspace, resolved across files (inheritance, attribute types). */
export class EntityModel {
  readonly classes: ModelClass[] = [];
  private readonly byEntityName = new Map<string, ModelClass>();
  private readonly byFqn = new Map<string, ModelClass>();
  private readonly bySimple = new Map<string, ModelClass[]>();
  /** Non-JPA types declared in the workspace (enums, DTOs…): known to be non-navigable. */
  private readonly otherTypes = new Set<string>();
  private readonly enumTypes = new Set<string>();

  constructor(files: Array<{ file: string; classes: ClassDecl[] }>) {
    const decls: Array<{ file: string; decl: ClassDecl }> = [];
    for (const f of files) {
      for (const decl of f.classes) {
        if (decl.kind === 'other') {
          this.otherTypes.add(decl.packageName ? `${decl.packageName}.${decl.name}` : decl.name);
          this.otherTypes.add(decl.name);
          if (decl.isEnum) {
            this.enumTypes.add(decl.name);
            this.enumTypes.add(decl.packageName ? `${decl.packageName}.${decl.name}` : decl.name);
          }
        } else {
          decls.push({ file: f.file, decl });
        }
      }
    }
    for (const { file, decl } of decls) {
      const cls: ModelClass = {
        name: decl.name, fqn: decl.packageName ? `${decl.packageName}.${decl.name}` : decl.name, kind: decl.kind,
        entityName: decl.entityName, file, offset: decl.offset, attributes: new Map(), incomplete: false, annotations: decl.annotations ?? {},
      };
      this.classes.push(cls);
      this.byFqn.set(cls.fqn, cls);
      this.bySimple.set(cls.name, [...(this.bySimple.get(cls.name) ?? []), cls]);
      if (cls.kind === 'entity' && cls.entityName) {
        this.byEntityName.set(cls.entityName, cls);
      }
    }
    // Attributes, walking up the superclass chain.
    const declOf = new Map(decls.map(d => [this.byFqn.get(d.decl.packageName ? `${d.decl.packageName}.${d.decl.name}` : d.decl.name)!, d.decl]));
    for (const cls of this.classes) {
      const seen = new Set<ModelClass>();
      let current: ModelClass | undefined = cls;
      const chain: ModelClass[] = [];
      while (current && !seen.has(current)) {
        seen.add(current);
        chain.unshift(current);
        const decl = declOf.get(current)!;
        if (!decl.superClass) {
          break;
        }
        const parent = this.lookupClass(decl.superClass, decl.packageName);
        if (!parent) {
          cls.incomplete = true;
          break;
        }
        current = parent;
      }
      for (const c of chain) {
        for (const a of declOf.get(c)!.attributes) {
          cls.attributes.set(a.name, { ...a, owner: c });
        }
      }
    }
  }

  private lookupClass(simple: string, preferPackage?: string): ModelClass | undefined {
    const candidates = this.bySimple.get(simple);
    if (!candidates?.length) {
      return undefined;
    }
    return candidates.find(c => c.fqn === `${preferPackage}.${simple}`) ?? candidates[0];
  }

  get isEmpty(): boolean {
    return this.byEntityName.size === 0;
  }

  entities(): ModelClass[] {
    return this.classes.filter(c => c.kind === 'entity').sort((a, b) => a.entityName!.localeCompare(b.entityName!));
  }

  /** Looks up an entity by JPQL entity name, or by fully qualified class name (HQL allows both). */
  entity(name: string): ModelClass | undefined {
    const byName = this.byEntityName.get(name);
    if (byName) {
      return byName;
    }
    const byFqn = this.byFqn.get(name);
    return byFqn?.kind === 'entity' ? byFqn : undefined;
  }

  /** The managed (entity/embeddable) class an attribute navigates to, if any. */
  target(attr: AttributeDecl): ModelClass | undefined {
    if (attr.elementTypeFqn && this.byFqn.has(attr.elementTypeFqn)) {
      return this.byFqn.get(attr.elementTypeFqn);
    }
    return this.lookupClass(attr.elementType);
  }

  /** True when the attribute's (element) type is an enum declared in the workspace. */
  isEnum(attr: AttributeDecl): boolean {
    return this.enumTypes.has(attr.elementTypeFqn ?? '') || this.enumTypes.has(attr.elementType);
  }

  /** True when the attribute's type is known not to have attributes (basic, enum, workspace non-JPA type). */
  isKnownBasic(attr: AttributeDecl): boolean {
    if (this.target(attr)) {
      return false;
    }
    return isBasicTypeName(attr.elementType) || this.otherTypes.has(attr.elementTypeFqn ?? '') || this.otherTypes.has(attr.elementType)
      || /^(java|javax|jakarta)\./.test(attr.elementTypeFqn ?? '');
  }
}

/** Optimal-string-alignment distance (Levenshtein + adjacent transpositions), for "did you mean" suggestions. */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array<number>(n).fill(0)]);
  for (let j = 1; j <= n; j++) {
    d[0][j] = j;
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

/** Best match for `name` among `candidates` (case-insensitive equality wins), or undefined if nothing is close. */
export function suggest(name: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestScore = Infinity;
  const lower = name.toLowerCase();
  for (const c of candidates) {
    if (c.toLowerCase() === lower) {
      return c;
    }
    const score = editDistance(lower, c.toLowerCase());
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  const limit = Math.max(1, Math.floor(name.length / 3));
  return best !== undefined && bestScore <= limit ? best : undefined;
}
