import { ConnectionConfig } from '../model/types';
import { GeneratorOptions } from './entityGenerator';
import { validatePackageName } from './naming';

/** Options as edited in the generator wizard. */
export interface UiOptions {
  sourceRoot: string;
  entityPackage: string;
  repositoryPackage: string;
  generateRepositories: boolean;
  persistenceApi: 'jakarta' | 'javax';
  lombok: boolean;
  relationships: boolean;
  inverseRelationships: boolean;
  versionColumn: boolean;
  stripTablePrefixes: string;
  alwaysSchema: boolean;
}

/** Returns field → message for invalid options. Pure, shared with tests. */
export function validateOptions(o: UiOptions): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!o.sourceRoot) {
    errors.sourceRoot = 'Choose the source folder (usually src/main/java)';
  }
  const ep = validatePackageName(o.entityPackage);
  if (!o.entityPackage) {
    errors.entityPackage = 'Entity package is required';
  } else if (ep) {
    errors.entityPackage = ep;
  }
  if (o.generateRepositories) {
    const rp = validatePackageName(o.repositoryPackage);
    if (!o.repositoryPackage) {
      errors.repositoryPackage = 'Repository package is required';
    } else if (rp) {
      errors.repositoryPackage = rp;
    }
  }
  return errors;
}

export function toGeneratorOptions(o: UiOptions, kind: ConnectionConfig['kind'], defaultSchema: string): GeneratorOptions {
  return {
    kind,
    entityPackage: o.entityPackage.trim(),
    repositoryPackage: o.repositoryPackage.trim(),
    generateRepositories: o.generateRepositories,
    persistenceApi: o.persistenceApi,
    lombok: o.lombok,
    relationships: o.relationships,
    inverseRelationships: o.relationships && o.inverseRelationships,
    versionColumn: o.versionColumn,
    stripTablePrefixes: o.stripTablePrefixes.split(/[,\s]+/).filter(Boolean),
    defaultSchema,
    alwaysIncludeSchema: o.alwaysSchema,
  };
}
