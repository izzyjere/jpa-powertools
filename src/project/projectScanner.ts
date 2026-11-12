import * as path from 'path';
import * as vscode from 'vscode';
import { analyzeBuildFile, commonPackage, suggestPackages, usesPersistenceApi } from './projectInfo';
import { extractDatasource, SpringDatasource } from './springConfig';

export interface SourceRoot {
  fsPath: string;
  /** Workspace-relative label, e.g. `backend/src/main/java`. */
  label: string;
  basePackage: string;
  entityPackage: string;
  repositoryPackage: string;
}

export interface ProjectInfo {
  roots: SourceRoot[];
  persistenceApi: 'jakarta' | 'javax';
  /** True when the persistence API was found in the build file or sources rather than defaulted. */
  persistenceApiDetected: boolean;
  lombok: boolean;
  springDataJpa: boolean;
}

const EXCLUDE = '**/{node_modules,target,build,out,bin,.git,.gradle,.idea}/**';
const decoder = new TextDecoder();

async function readText(uri: vscode.Uri): Promise<string> {
  try {
    return decoder.decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return '';
  }
}

async function isDirectory(uri: vscode.Uri): Promise<boolean> {
  try {
    return ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) !== 0;
  } catch {
    return false;
  }
}

function relativeLabel(fsPath: string): string {
  return vscode.workspace.asRelativePath(fsPath, (vscode.workspace.workspaceFolders?.length ?? 0) > 1).replace(/\\/g, '/');
}

/** Describes a single source root: its base package and suggested entity/repository packages. */
export async function describeSourceRoot(root: vscode.Uri): Promise<SourceRoot> {
  const javaFiles = await vscode.workspace.findFiles(new vscode.RelativePattern(root, '**/*.java'), EXCLUDE, 5000);
  const packages = new Set<string>();
  for (const f of javaFiles) {
    const rel = path.relative(root.fsPath, path.dirname(f.fsPath));
    if (rel && !rel.startsWith('..')) {
      packages.add(rel.split(path.sep).join('.'));
    }
  }

  // The @SpringBootApplication class defines the base package; fall back to the common prefix.
  let basePackage: string | undefined;
  const candidates = javaFiles.filter(f => /Application\.java$/.test(f.fsPath)).slice(0, 10);
  for (const f of candidates) {
    if (/@SpringBootApplication/.test(await readText(f))) {
      const rel = path.relative(root.fsPath, path.dirname(f.fsPath));
      basePackage = rel ? rel.split(path.sep).join('.') : '';
      break;
    }
  }
  if (basePackage === undefined) {
    basePackage = commonPackage([...packages]);
  }
  if (!basePackage) {
    basePackage = 'com.example';
  }
  return { fsPath: root.fsPath, label: relativeLabel(root.fsPath), basePackage, ...suggestPackages(basePackage, [...packages]) };
}

export async function scanProject(): Promise<ProjectInfo> {
  const buildFiles = await vscode.workspace.findFiles('**/{pom.xml,build.gradle,build.gradle.kts}', EXCLUDE, 50);
  const rootUris = new Map<string, vscode.Uri>();
  for (const b of buildFiles) {
    const candidate = vscode.Uri.file(path.join(path.dirname(b.fsPath), 'src', 'main', 'java'));
    if (await isDirectory(candidate)) {
      rootUris.set(candidate.fsPath, candidate);
    }
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const candidate = vscode.Uri.joinPath(folder.uri, 'src', 'main', 'java');
    if (!rootUris.has(candidate.fsPath) && await isDirectory(candidate)) {
      rootUris.set(candidate.fsPath, candidate);
    }
  }

  let persistenceApi: ProjectInfo['persistenceApi'] | undefined;
  let lombok = false;
  let springDataJpa = false;
  for (const b of buildFiles) {
    const facts = analyzeBuildFile(await readText(b));
    persistenceApi = persistenceApi ?? facts.persistenceApi;
    lombok = lombok || facts.lombok;
    springDataJpa = springDataJpa || facts.springDataJpa;
  }
  if (!persistenceApi) {
    const sample = await vscode.workspace.findFiles('**/src/main/java/**/*.java', EXCLUDE, 60);
    for (const f of sample) {
      persistenceApi = usesPersistenceApi(await readText(f));
      if (persistenceApi) {
        break;
      }
    }
  }

  // Shallow roots first so the main module is the default choice.
  const sortedRoots = [...rootUris.values()].sort((a, b) => a.fsPath.length - b.fsPath.length || a.fsPath.localeCompare(b.fsPath));
  const roots = await Promise.all(sortedRoots.map(describeSourceRoot));
  return {
    roots,
    persistenceApi: persistenceApi ?? 'jakarta',
    persistenceApiDetected: persistenceApi !== undefined,
    lombok,
    springDataJpa,
  };
}

export interface FoundDatasource extends SpringDatasource {
  file: string;
}

/** Finds `spring.datasource.*` settings in application*.properties / *.yml files of the workspace. */
export async function findSpringDatasources(): Promise<FoundDatasource[]> {
  const files = await vscode.workspace.findFiles('**/src/{main,test}/resources/**/application*.{properties,yml,yaml}', EXCLUDE, 50);
  const found: FoundDatasource[] = [];
  for (const f of files) {
    const ds = extractDatasource(f.fsPath, await readText(f));
    if (ds) {
      found.push({ ...ds, file: relativeLabel(f.fsPath) });
    }
  }
  // Main config before test config, default profile before named profiles.
  return found.sort((a, b) => Number(a.file.includes('/test/')) - Number(b.file.includes('/test/'))
    || Number(!!a.profile) - Number(!!b.profile) || a.file.localeCompare(b.file));
}
