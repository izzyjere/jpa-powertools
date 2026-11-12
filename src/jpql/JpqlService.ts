import * as vscode from 'vscode';
import { deriveJpql } from './derivedQuery';
import { EntityModel, ModelClass } from './entityModel';
import { ClassDecl, extractQueries, JpqlQuery, MappedString, parseJavaClasses, repositoryMethods, tokenizeJava } from './javaSource';
import { analyzeJpql, checkMethodParameters, completeJpql, JpqlCompletion, referenceAt } from './jpql';
import { buildQuery, conditionPaths, ConditionOp, javaStringLiteral, QueryCondition, QuerySpec } from './queryBuilder';

const EXCLUDE = '**/{node_modules,target,build,out,bin,.git,.gradle,.idea}/**';
const JPA_MARKER = /@(Entity|Embeddable|MappedSuperclass)\b/;
const decoder = new TextDecoder();

/** Indexes JPA classes in the workspace and keeps an up-to-date entity model. */
export class EntityIndex implements vscode.Disposable {
  private readonly files = new Map<string, { file: string; classes: ClassDecl[] }>();
  private cached: EntityModel | undefined;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private ready: Promise<void> | undefined;

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.java');
    this.disposables.push(
      watcher,
      watcher.onDidCreate(uri => this.updateFromDisk(uri)),
      watcher.onDidChange(uri => this.updateFromDisk(uri)),
      watcher.onDidDelete(uri => this.remove(uri)),
      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.languageId === 'java') {
          this.updateText(e.document.uri, e.document.getText());
        }
      }),
      this.emitter,
    );
  }

  /** Scans the workspace once; later calls return the same promise. */
  whenReady(): Promise<void> {
    this.ready ??= Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Indexing JPA entities' }, async () => {
      const uris = await vscode.workspace.findFiles('**/*.java', EXCLUDE, 20_000);
      for (let i = 0; i < uris.length; i += 64) {
        await Promise.all(uris.slice(i, i + 64).map(async uri => {
          const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
          const text = open ? open.getText() : await vscode.workspace.fs.readFile(uri).then(b => decoder.decode(b), () => '');
          this.updateText(uri, text, false);
        }));
      }
      this.cached = undefined;
      this.emitter.fire();
    }));
    return this.ready;
  }

  get model(): EntityModel {
    this.cached ??= new EntityModel([...this.files.values()]);
    return this.cached;
  }

  private updateText(uri: vscode.Uri, text: string, notify = true) {
    const key = uri.toString();
    const had = this.files.has(key);
    if (!JPA_MARKER.test(text)) {
      if (had) {
        this.files.delete(key);
        this.invalidate(notify);
      }
      return;
    }
    const classes = parseJavaClasses(text).filter(c => c.kind !== 'other' || /\benum\b/.test(text));
    this.files.set(key, { file: uri.toString(), classes });
    this.invalidate(notify);
  }

  private async updateFromDisk(uri: vscode.Uri) {
    if (vscode.workspace.textDocuments.some(d => d.uri.toString() === uri.toString() && d.isDirty)) {
      return; // the editor buffer is the source of truth
    }
    try {
      this.updateText(uri, decoder.decode(await vscode.workspace.fs.readFile(uri)));
    } catch {
      this.remove(uri);
    }
  }

  private remove(uri: vscode.Uri) {
    if (this.files.delete(uri.toString())) {
      this.invalidate(true);
    }
  }

  private invalidate(notify: boolean) {
    this.cached = undefined;
    if (notify) {
      this.emitter.fire();
    }
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}

/** Maps a query-relative range to a document range. */
function toRange(doc: vscode.TextDocument, q: MappedString, start: number, end: number): vscode.Range {
  const s = q.offsets[Math.min(start, q.offsets.length - 1)];
  const lastChar = Math.max(start, end - 1);
  const e = end > start ? q.offsets[Math.min(lastChar, q.offsets.length - 1)] + 1 : s;
  return new vscode.Range(doc.positionAt(s), doc.positionAt(Math.max(s, e)));
}

/** Maps a document offset into a query (index of the first query character at or after the offset). */
function toQueryOffset(q: MappedString, docOffset: number): number | undefined {
  if (docOffset < q.offsets[0] || docOffset > q.offsets[q.offsets.length - 1]) {
    return undefined;
  }
  let lo = 0;
  let hi = q.offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (q.offsets[mid] < docOffset) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

const COMPLETION_KIND: Record<JpqlCompletion['kind'], vscode.CompletionItemKind> = {
  entity: vscode.CompletionItemKind.Class,
  attribute: vscode.CompletionItemKind.Field,
  association: vscode.CompletionItemKind.Reference,
  alias: vscode.CompletionItemKind.Variable,
  keyword: vscode.CompletionItemKind.Keyword,
  function: vscode.CompletionItemKind.Function,
  parameter: vscode.CompletionItemKind.TypeParameter,
};

/** Wires JPQL diagnostics, completion, navigation, refactorings and the query builder into VS Code. */
export class JpqlService implements vscode.Disposable {
  readonly index = new EntityIndex();
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('jpql');
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Quick-fix replacements keyed by uri|range|message. */
  private readonly fixes = new Map<string, string>();

  constructor() {
    const selector: vscode.DocumentSelector = { language: 'java' };
    this.disposables.push(
      this.index,
      this.diagnostics,
      vscode.workspace.onDidOpenTextDocument(d => this.schedule(d, 0)),
      vscode.workspace.onDidChangeTextDocument(e => this.schedule(e.document, 300)),
      vscode.workspace.onDidCloseTextDocument(d => this.diagnostics.delete(d.uri)),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('jpaPowertools.jpql')) {
          this.validateAll();
        }
      }),
      this.index.onDidChange(() => this.validateAllSoon()),
      vscode.languages.registerCompletionItemProvider(selector, { provideCompletionItems: (d, p) => this.complete(d, p) }, '.', ':', ' '),
      vscode.languages.registerHoverProvider(selector, { provideHover: (d, p) => this.hover(d, p) }),
      vscode.languages.registerDefinitionProvider(selector, { provideDefinition: (d, p) => this.definition(d, p) }),
      vscode.languages.registerCodeActionsProvider(selector, { provideCodeActions: (d, r, c) => this.codeActions(d, r, c) }, {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorRewrite],
      }),
      vscode.commands.registerCommand('jpaPowertools.generateJpql', () => this.generateJpql()),
      vscode.commands.registerCommand('jpaPowertools.convertToQuery', (uri: vscode.Uri, methodName: string) => this.convertCommand(uri, methodName)),
    );
    this.index.whenReady().then(() => this.validateAll());
    for (const doc of vscode.workspace.textDocuments) {
      this.schedule(doc, 0);
    }
  }

  private get enabled(): boolean {
    return vscode.workspace.getConfiguration('jpaPowertools.jpql').get<boolean>('validation', true);
  }

  private schedule(doc: vscode.TextDocument, delay: number) {
    if (doc.languageId !== 'java' || doc.uri.scheme === 'git') {
      return;
    }
    const key = doc.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      this.validate(doc);
    }, delay));
  }

  private validateAllTimer: NodeJS.Timeout | undefined;
  private validateAllSoon() {
    clearTimeout(this.validateAllTimer);
    this.validateAllTimer = setTimeout(() => this.validateAll(), 400);
  }

  private validateAll() {
    for (const doc of vscode.workspace.textDocuments) {
      this.validate(doc);
    }
  }

  private queries(doc: vscode.TextDocument): JpqlQuery[] {
    return extractQueries(doc.getText());
  }

  /** Validates all JPQL in a document and publishes diagnostics. Returns them (useful for tests). */
  validate(doc: vscode.TextDocument): vscode.Diagnostic[] {
    if (doc.languageId !== 'java' || doc.isClosed) {
      return [];
    }
    if (!this.enabled) {
      this.diagnostics.delete(doc.uri);
      return [];
    }
    const model = this.index.model;
    const out: vscode.Diagnostic[] = [];
    const text = doc.getText();
    for (const q of this.queries(doc)) {
      const analysis = analyzeJpql(q.query.value, model);
      const problems = [...analysis.diagnostics];
      let unbound: Array<{ start: number; end: number; message: string }> = [];
      if (q.method && q.source === 'query') {
        const check = checkMethodParameters(analysis, q.method);
        problems.push(...check.query);
        unbound = check.unboundParams.map(u => {
          const nameAt = text.indexOf(u.param.name, u.param.start);
          const start = nameAt >= 0 ? nameAt : u.param.start;
          return { start, end: start + u.param.name.length, message: u.message };
        });
      }
      for (const p of problems) {
        const range = toRange(doc, q.query, p.start, p.end);
        const d = new vscode.Diagnostic(range, p.message, p.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
        d.source = 'JPQL';
        d.code = p.code;
        if (p.replacement !== undefined) {
          this.fixes.set(`${doc.uri}|${range.start.line}:${range.start.character}|${p.message}`, p.replacement);
        }
        out.push(d);
      }
      for (const u of unbound) {
        const d = new vscode.Diagnostic(new vscode.Range(doc.positionAt(u.start), doc.positionAt(u.end)), u.message, vscode.DiagnosticSeverity.Error);
        d.source = 'JPQL';
        d.code = 'parameter';
        out.push(d);
      }
    }
    this.diagnostics.set(doc.uri, out);
    return out;
  }

  private queryAt(doc: vscode.TextDocument, pos: vscode.Position): { q: JpqlQuery; offset: number } | undefined {
    const docOffset = doc.offsetAt(pos);
    for (const q of this.queries(doc)) {
      const offset = toQueryOffset(q.query, docOffset);
      if (offset !== undefined) {
        return { q, offset };
      }
    }
    return undefined;
  }

  private complete(doc: vscode.TextDocument, pos: vscode.Position): vscode.CompletionItem[] | undefined {
    const at = this.queryAt(doc, pos);
    if (!at) {
      return undefined;
    }
    const paramNames = at.q.method?.params.map(p => p.paramAnnotation ?? p.name) ?? [];
    const result = completeJpql(at.q.query.value, at.offset, this.index.model, paramNames);
    const range = toRange(doc, at.q.query, result.replaceStart, result.replaceEnd);
    return result.items.map(i => {
      const item = new vscode.CompletionItem(i.label, COMPLETION_KIND[i.kind]);
      item.detail = i.detail;
      item.insertText = i.insertText ?? i.label;
      item.sortText = `${i.rank}_${i.label}`;
      item.range = new vscode.Range(range.start, pos);
      if (i.insertText?.endsWith('.') || i.insertText?.endsWith('(')) {
        item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest' };
      }
      return item;
    });
  }

  private hover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    const at = this.queryAt(doc, pos);
    if (!at) {
      return undefined;
    }
    const analysis = analyzeJpql(at.q.query.value, this.index.model);
    const ref = referenceAt(analysis, at.offset);
    if (!ref) {
      return undefined;
    }
    const md = new vscode.MarkdownString();
    if (ref.kind === 'entity') {
      md.appendMarkdown(`**${ref.cls.entityName}** · entity\n\n`);
      md.appendCodeblock(`class ${ref.cls.fqn}`, 'java');
      md.appendMarkdown(`\n${ref.cls.attributes.size} attributes`);
    } else {
      const a = ref.attribute!;
      const target = this.index.model.target(a);
      const nature = a.collection ? 'collection' : target?.kind === 'entity' ? 'association' : target?.kind === 'embeddable' ? 'embedded' : 'attribute';
      md.appendMarkdown(`**${ref.cls.entityName ?? ref.cls.name}.${a.name}** · ${nature}\n\n`);
      md.appendCodeblock(`${a.type} ${a.name}`, 'java');
      if (a.owner !== ref.cls) {
        md.appendMarkdown(`\nDeclared in \`${a.owner.name}\``);
      }
    }
    return new vscode.Hover(md, toRange(doc, at.q.query, ref.start, ref.end));
  }

  private async definition(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Location | undefined> {
    const at = this.queryAt(doc, pos);
    if (!at) {
      return undefined;
    }
    const ref = referenceAt(analyzeJpql(at.q.query.value, this.index.model), at.offset);
    if (!ref) {
      return undefined;
    }
    const file = ref.attribute ? ref.attribute.owner.file : ref.cls.file;
    const offset = ref.attribute ? ref.attribute.offset : ref.cls.offset;
    const target = await vscode.workspace.openTextDocument(vscode.Uri.parse(file));
    return new vscode.Location(target.uri, target.positionAt(offset));
  }

  private codeActions(doc: vscode.TextDocument, range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const d of context.diagnostics) {
      if (d.source !== 'JPQL') {
        continue;
      }
      const replacement = this.fixes.get(`${doc.uri}|${d.range.start.line}:${d.range.start.character}|${d.message}`);
      if (replacement === undefined) {
        continue;
      }
      const action = new vscode.CodeAction(replacement ? `Change to '${replacement}'` : 'Remove', vscode.CodeActionKind.QuickFix);
      action.edit = new vscode.WorkspaceEdit();
      action.edit.replace(doc.uri, d.range, replacement);
      action.diagnostics = [d];
      action.isPreferred = true;
      actions.push(action);
    }

    // "Convert to @Query" for the derived query method under the cursor.
    const text = doc.getText();
    const offset = doc.offsetAt(range.start);
    const method = repositoryMethods(text).find(m => offset >= m.declStart && offset <= m.nameEnd + 1);
    if (method && !method.annotations.includes('Query')) {
      const action = new vscode.CodeAction('Convert to @Query (JPQL)', vscode.CodeActionKind.RefactorRewrite);
      const edit = this.conversionEdit(doc, method.name);
      if (typeof edit === 'string') {
        action.disabled = { reason: edit };
      } else {
        action.edit = edit;
      }
      actions.push(action);
    }
    return actions;
  }

  /** Builds the edit that turns a derived query method into an explicit @Query, or explains why not. */
  conversionEdit(doc: vscode.TextDocument, methodName: string): vscode.WorkspaceEdit | string {
    const text = doc.getText();
    const tokens = tokenizeJava(text);
    const method = repositoryMethods(text, tokens).find(m => m.name === methodName);
    if (!method) {
      return `Method ${methodName} not found`;
    }
    const entity = this.index.model.classes.find(c => c.name === method.domainType && c.kind === 'entity');
    if (!entity) {
      return `Entity ${method.domainType} is not in this workspace`;
    }
    const result = deriveJpql(method, entity, this.index.model);
    if (!result.ok) {
      return result.reason;
    }
    const edit = new vscode.WorkspaceEdit();
    const declPos = doc.positionAt(method.declStart);
    const indent = doc.lineAt(declPos.line).text.substring(0, declPos.character).match(/^\s*/)![0];
    edit.insert(doc.uri, declPos, `@Query(${javaStringLiteral(result.jpql)})\n${indent}`);
    const needsParam = result.params.filter(p => !p.paramAnnotation && result.jpql.includes(`:${p.name}`));
    for (const p of needsParam) {
      edit.insert(doc.uri, doc.positionAt(p.start), `@Param("${p.name}") `);
    }
    this.addImports(doc, edit, ['org.springframework.data.jpa.repository.Query', ...(needsParam.length ? ['org.springframework.data.repository.query.Param'] : [])]);
    return edit;
  }

  private async convertCommand(uri: vscode.Uri, methodName: string): Promise<boolean> {
    const doc = await vscode.workspace.openTextDocument(uri);
    await this.index.whenReady();
    const edit = this.conversionEdit(doc, methodName);
    if (typeof edit === 'string') {
      vscode.window.showWarningMessage(edit);
      return false;
    }
    return vscode.workspace.applyEdit(edit);
  }

  /** Adds missing imports after the last import (or the package declaration). */
  private addImports(doc: vscode.TextDocument, edit: vscode.WorkspaceEdit, fqns: string[]) {
    const text = doc.getText();
    const missing = fqns.filter(f => {
      const pkg = f.substring(0, f.lastIndexOf('.'));
      return !new RegExp(`^\\s*import\\s+(${f.replace(/\./g, '\\.')}|${pkg.replace(/\./g, '\\.')}\\.\\*)\\s*;`, 'm').test(text)
        && !/^java\.lang\.[A-Z]\w*$/.test(f);
    });
    if (!missing.length) {
      return;
    }
    const lines = text.split(/\r?\n/);
    let line = -1;
    lines.forEach((l, i) => {
      if (/^\s*import\s/.test(l)) {
        line = i;
      }
    });
    const insertText = missing.map(f => `import ${f};`).join('\n');
    if (line >= 0) {
      edit.insert(doc.uri, new vscode.Position(line + 1, 0), `${insertText}\n`);
    } else {
      const pkg = lines.findIndex(l => /^\s*package\s/.test(l));
      edit.insert(doc.uri, new vscode.Position(pkg + 1, 0), `\n${insertText}\n`);
    }
  }

  // ------------------------------------------------------------------------------------------ builder

  async generateJpql(): Promise<void> {
    await this.index.whenReady();
    const model = this.index.model;
    const entities = model.entities();
    if (!entities.length) {
      vscode.window.showInformationMessage('No @Entity classes were found in this workspace. Generate entities from a database first, or open the project that contains them.');
      return;
    }
    const editor = vscode.window.activeTextEditor;
    const repo = editor?.document.languageId === 'java'
      ? repositoryMethodsContext(editor.document, editor.selection.active)
      : undefined;
    const steps = 5;
    const title = (n: number) => `Generate JPQL Query (${n}/${steps})`;

    const entityPick = await vscode.window.showQuickPick(entities.map(e => ({
      label: e.entityName!, description: e.fqn, detail: `${e.attributes.size} attributes`, entity: e, picked: e.name === repo?.domainType,
    })).sort((a, b) => Number(b.picked) - Number(a.picked)), { title: title(1), placeHolder: 'Which entity does the query return?' });
    if (!entityPick) {
      return;
    }
    const entity = entityPick.entity;

    const kindPick = await vscode.window.showQuickPick([
      { label: 'Find a list', description: 'List<' + entity.name + '>', queryKind: 'list' as const },
      { label: 'Find one', description: 'Optional<' + entity.name + '>', queryKind: 'one' as const },
      { label: 'Count', description: 'long', queryKind: 'count' as const },
      { label: 'Exists', description: 'boolean', queryKind: 'exists' as const },
    ], { title: title(2), placeHolder: 'What should the query do?' });
    if (!kindPick) {
      return;
    }

    const paths = conditionPaths(model, entity);
    const condPicks = await vscode.window.showQuickPick(paths.map(p => ({
      label: p.path.join('.'), description: p.attr.type, path: p.path,
    })), { title: title(3), placeHolder: 'Filter by… (select none for no WHERE clause)', canPickMany: true });
    if (!condPicks) {
      return;
    }
    const conditions: QueryCondition[] = [];
    for (const c of condPicks) {
      const isString = /String/.test(c.description ?? '');
      const ops: Array<{ label: ConditionOp; description: string }> = [
        { label: '=', description: 'equals' },
        ...(isString ? [{ label: 'like' as ConditionOp, description: 'matches a pattern (% and _ wildcards)' }] : []),
        { label: 'in', description: 'is one of a collection' },
        { label: '<>', description: 'not equal' },
        { label: '>', description: 'greater than' }, { label: '>=', description: 'greater than or equal' },
        { label: '<', description: 'less than' }, { label: '<=', description: 'less than or equal' },
        { label: 'is null', description: 'has no value' }, { label: 'is not null', description: 'has a value' },
      ];
      const op = await vscode.window.showQuickPick(ops, { title: `${title(3)} · ${c.label}`, placeHolder: `How should ${c.label} be compared?` });
      if (!op) {
        return;
      }
      conditions.push({ path: c.path, op: op.label });
    }

    let fetch: string[] = [];
    let orderBy: QuerySpec['orderBy'];
    if (kindPick.queryKind === 'list' || kindPick.queryKind === 'one') {
      const associations = [...entity.attributes.values()].filter(a => model.target(a)?.kind === 'entity');
      if (associations.length) {
        const f = await vscode.window.showQuickPick(associations.map(a => ({
          label: a.name, description: a.type, detail: a.collection ? 'collection: adds DISTINCT' : undefined,
        })), { title: title(4), placeHolder: 'Fetch associations in the same query? (avoids N+1 selects; select none to skip)', canPickMany: true });
        if (!f) {
          return;
        }
        fetch = f.map(x => x.label);
      }
      if (kindPick.queryKind === 'list') {
        const o = await vscode.window.showQuickPick([
          { label: 'No ordering', path: undefined as string[] | undefined },
          ...paths.map(p => ({ label: p.path.join('.'), description: p.attr.type, path: p.path })),
        ], { title: title(5), placeHolder: 'Order by…' });
        if (!o) {
          return;
        }
        if (o.path) {
          const dir = await vscode.window.showQuickPick(['asc', 'desc'], { title: title(5), placeHolder: 'Direction' });
          if (!dir) {
            return;
          }
          orderBy = { path: o.path, direction: dir as 'asc' | 'desc' };
        }
      }
    }

    const built = buildQuery(model, { entity, kind: kindPick.queryKind, conditions, fetch, orderBy });
    await this.insertQuery(built, entity, repo?.domainType === entity.name);
  }

  private async insertQuery(built: ReturnType<typeof buildQuery>, entity: ModelClass, inRepository: boolean) {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'java' && inRepository) {
      const doc = editor.document;
      const line = doc.lineAt(editor.selection.active.line);
      const indent = line.text.match(/^\s*/)![0] || '    ';
      const params = built.params.map(p => `@Param("${p.name}") ${p.type} ${p.name}`).join(', ');
      const method = `${indent}@Query(${javaStringLiteral(built.jpql)})\n${indent}${built.returnType} ${built.methodName}(${params});\n`;
      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, line.range.start, line.isEmptyOrWhitespace ? method.replace(/^\s+/, indent) : `${method}\n`);
      const imports = ['org.springframework.data.jpa.repository.Query'];
      if (built.params.length) {
        imports.push('org.springframework.data.repository.query.Param');
      }
      if (built.returnType.startsWith('List<')) {
        imports.push('java.util.List');
      }
      if (built.returnType.startsWith('Optional<')) {
        imports.push('java.util.Optional');
      }
      if (built.params.some(p => p.type.startsWith('Collection<'))) {
        imports.push('java.util.Collection');
      }
      const pkgOfDoc = /^\s*package\s+([\w.]+)\s*;/m.exec(doc.getText())?.[1];
      for (const p of built.params) {
        if (p.typeFqn && /\./.test(p.typeFqn) && !p.typeFqn.startsWith('java.lang.') && p.typeFqn.substring(0, p.typeFqn.lastIndexOf('.')) !== pkgOfDoc) {
          imports.push(p.typeFqn);
        }
      }
      if (entity.fqn.substring(0, entity.fqn.lastIndexOf('.')) !== pkgOfDoc) {
        imports.push(entity.fqn);
      }
      this.addImports(doc, edit, [...new Set(imports)]);
      await vscode.workspace.applyEdit(edit);
      vscode.window.setStatusBarMessage(`Added ${built.methodName}() to the repository`, 4000);
      return;
    }
    if (editor && editor.document.languageId === 'java') {
      await editor.insertSnippet(new vscode.SnippetString().appendText(javaStringLiteral(built.jpql)));
      return;
    }
    await vscode.env.clipboard.writeText(built.jpql);
    const open = await vscode.window.showInformationMessage(`Copied to the clipboard: ${built.jpql}`, 'Open in Editor');
    if (open) {
      const doc = await vscode.workspace.openTextDocument({ content: built.jpql, language: 'sql' });
      await vscode.window.showTextDocument(doc);
    }
  }

  dispose(): void {
    this.timers.forEach(t => clearTimeout(t));
    clearTimeout(this.validateAllTimer);
    this.disposables.forEach(d => d.dispose());
  }
}

/** The repository interface around the cursor, if any. */
function repositoryMethodsContext(doc: vscode.TextDocument, pos: vscode.Position): { domainType: string } | undefined {
  const text = doc.getText();
  const offset = doc.offsetAt(pos);
  const cls = parseJavaClasses(text).find(c => c.isInterface && c.repositoryOf && offset >= c.bodyStart && offset <= c.bodyEnd);
  return cls ? { domainType: cls.repositoryOf! } : undefined;
}
