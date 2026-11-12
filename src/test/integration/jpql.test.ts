import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { JpaPowerToolsApi } from '../../extension';
import { screenshot } from './screenshot';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) {
      return v;
    }
    if (Date.now() > end) {
      throw new Error('Timed out waiting for condition');
    }
    await sleep(100);
  }
}

const jpqlDiagnostics = (uri: vscode.Uri) => vscode.languages.getDiagnostics(uri).filter(d => d.source === 'JPQL');

suite('JPQL in VS Code', () => {
  let api: JpaPowerToolsApi;
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const repoDir = path.join(root, 'src/main/java/com/acme/shop/repository');
  const scratchFiles: string[] = [];

  suiteSetup(async () => {
    api = await vscode.extensions.getExtension<JpaPowerToolsApi>('izzyjere.jpa-powertools')!.activate();
    await api.jpql.index.whenReady();
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    scratchFiles.forEach(f => fs.rmSync(f, { force: true }));
  });

  /** Writes a fresh repository file (a new name each time: open documents are not reloaded from disk). */
  async function openScratch(body: string): Promise<vscode.TextEditor> {
    const name = `ZzScratch${scratchFiles.length + 1}Repository`;
    const scratch = path.join(repoDir, `${name}.java`);
    scratchFiles.push(scratch);
    fs.writeFileSync(scratch, [
      'package com.acme.shop.repository;',
      '',
      'import com.acme.shop.domain.Customer;',
      'import com.acme.shop.domain.CustomerStatus;',
      'import org.springframework.data.jpa.repository.JpaRepository;',
      'import org.springframework.data.jpa.repository.Query;',
      '',
      'import java.util.List;',
      '',
      `public interface ${name} extends JpaRepository<Customer, Long> {`,
      body,
      '}',
      '',
    ].join('\n'));
    const doc = await vscode.workspace.openTextDocument(scratch);
    return vscode.window.showTextDocument(doc);
  }

  test('indexes the workspace entities', () => {
    const names = api.jpql.index.model.entities().map(e => e.entityName);
    assert.deepStrictEqual(names, ['Customer', 'Order', 'OrderItem', 'Product']);
  });

  test('reports no problems for valid repositories', async () => {
    for (const file of ['CustomerRepository.java', 'OrderRepository.java']) {
      const doc = await vscode.workspace.openTextDocument(path.join(repoDir, file));
      assert.deepStrictEqual(api.jpql.validate(doc).map(d => d.message), [], file);
    }
  });

  test('underlines mistakes precisely and offers quick fixes', async () => {
    const editor = await openScratch([
      '    @Query("select c from Customer c where c.emial = :email and c.address.town = :town")',
      '    List<Customer> broken(String email, String town, int unused);',
    ].join('\n'));
    const doc = editor.document;
    const diags = await waitFor(() => {
      const d = jpqlDiagnostics(doc.uri);
      return d.length >= 3 ? d : undefined;
    });
    const byText = new Map(diags.map(d => [doc.getText(d.range), d]));
    assert.match(byText.get('emial')!.message, /no attribute 'emial'. Did you mean 'email'\?/);
    assert.match(byText.get('town')!.message, /Embeddable 'Address' has no attribute 'town'/);
    assert.match(byText.get('unused')!.message, /not used in the query/);
    await sleep(800);
    screenshot('06-jpql-diagnostics');

    const emial = byText.get('emial')!;
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', doc.uri, emial.range, vscode.CodeActionKind.QuickFix.value);
    const fix = actions.find(a => a.title === "Change to 'email'");
    assert.ok(fix?.edit, 'quick fix offered');
    await vscode.workspace.applyEdit(fix.edit);
    await waitFor(() => !jpqlDiagnostics(doc.uri).some(d => /emial/.test(d.message)) || undefined);
    assert.ok(doc.getText().includes('c.email = :email'));
  });

  test('completes attributes, hovers and jumps to the entity field', async () => {
    const editor = await openScratch([
      '    @Query("select c from Customer c where c.address.city = :city")',
      '    List<Customer> byCity(String city);',
    ].join('\n'));
    const doc = editor.document;
    const text = doc.getText();

    const afterDot = doc.positionAt(text.indexOf('c.address.') + 'c.address.'.length);
    const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, afterDot, '.');
    const labels = list.items.map(i => (typeof i.label === 'string' ? i.label : i.label.label));
    for (const l of ['street', 'city', 'zipCode']) {
      assert.ok(labels.includes(l), `completes ${l}`);
    }

    const onCity = doc.positionAt(text.indexOf('city =') + 1);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, onCity);
    const hoverText = hovers.flatMap(h => h.contents.map(c => (typeof c === 'string' ? c : (c as vscode.MarkdownString).value))).join('\n');
    assert.match(hoverText, /Address\.city/, `hover at ${JSON.stringify(doc.getText(new vscode.Range(onCity, onCity.translate(0, 4))))}`);

    const onAddress = doc.positionAt(text.indexOf('address.city') + 2);
    const defs = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>('vscode.executeDefinitionProvider', doc.uri, onAddress);
    const def = defs[0] as vscode.Location;
    assert.ok(def.uri.fsPath.endsWith('Customer.java'), def.uri.fsPath);
    const target = await vscode.workspace.openTextDocument(def.uri);
    assert.match(target.lineAt(def.range.start.line).text, /private Address address;/);

    // Show the completion widget for the screenshot
    editor.selection = new vscode.Selection(afterDot, afterDot);
    await vscode.commands.executeCommand('editor.action.triggerSuggest');
    await sleep(1500);
    screenshot('07-jpql-completion');
    await vscode.commands.executeCommand('hideSuggestWidget');
  });

  test('generates a repository method with the JPQL query builder', async function () {
    const editor = await openScratch('    \n');
    const doc = editor.document;
    const line = doc.getText().split('\n').findIndex(l => /^\s*$/.test(l) && l.length > 0);
    editor.selection = new vscode.Selection(line, 4, line, 4);

    // Answer the wizard's quick picks: Customer → list → filter by email (=) → no fetch → order by fullName desc.
    const answers: Array<(items: readonly vscode.QuickPickItem[]) => vscode.QuickPickItem | vscode.QuickPickItem[] | string | undefined> = [
      items => items.find(i => i.label === 'Customer'),
      items => items.find(i => i.label === 'Find a list'),
      items => items.filter(i => i.label === 'email'),
      items => items.find(i => i.label === '='),
      () => [],
      items => items.find(i => i.label === 'fullName'),
      () => 'desc',
    ];
    const original = vscode.window.showQuickPick;
    try {
      (vscode.window as { showQuickPick: unknown }).showQuickPick = async (items: readonly vscode.QuickPickItem[] | Thenable<readonly vscode.QuickPickItem[]>) =>
        answers.shift()!(await items);
    } catch {
      this.skip(); // the API object is frozen in this VS Code version
    }
    try {
      await vscode.commands.executeCommand('jpaPowertools.generateJpql');
    } finally {
      (vscode.window as { showQuickPick: unknown }).showQuickPick = original;
    }
    assert.strictEqual(answers.length, 0, 'every wizard step was answered');
    const text = doc.getText();
    assert.ok(text.includes('    @Query("select c from Customer c where c.email = :email order by c.fullName desc")\n'
      + '    List<Customer> findByEmailOrderByFullNameDesc(@Param("email") String email);'), text);
    assert.ok(text.includes('import org.springframework.data.repository.query.Param;'));
    assert.deepStrictEqual(api.jpql.validate(doc).map(d => d.message), []);
  });

  test('converts a derived query method to @Query and explains when it cannot', async () => {
    const editor = await openScratch([
      '    List<Customer> findByAddressCityAndStatusOrderByFullNameAsc(String city, CustomerStatus status);',
      '',
      '    List<Customer> findTop3ByEmail(String email);',
    ].join('\n'));
    const doc = editor.document;
    const text = doc.getText();
    const at = (s: string) => {
      const p = doc.positionAt(text.indexOf(s) + 2);
      return new vscode.Range(p, p);
    };

    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', doc.uri, at('findByAddress'), vscode.CodeActionKind.RefactorRewrite.value);
    const convert = actions.find(a => a.title === 'Convert to @Query (JPQL)');
    assert.ok(convert?.edit, `refactoring offered: ${JSON.stringify(actions.map(a => [a.title, a.disabled, !!a.edit]))}`);

    // Disabled refactorings show in the Refactor menu with their reason (the command API omits them).
    assert.match(String(api.jpql.conversionEdit(doc, 'findTop3ByEmail')), /First\/Top limits cannot be expressed in JPQL/);

    await vscode.workspace.applyEdit(convert.edit);
    const after = doc.getText();
    assert.ok(after.includes('    @Query("select c from Customer c where c.address.city = :city and c.status = :status order by c.fullName asc")\n'
      + '    List<Customer> findByAddressCityAndStatusOrderByFullNameAsc(@Param("city") String city, @Param("status") CustomerStatus status);'), after);
    assert.ok(after.includes('import org.springframework.data.repository.query.Param;'));
    assert.deepStrictEqual(api.jpql.validate(doc).map(d => d.message), [], 'the generated query validates');
    await doc.save();
  });
});
