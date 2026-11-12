/**
 * Scripted product demo, recorded by `node scripts/record-demo.js` (see that file for prerequisites).
 * Runs inside a real VS Code window, drives the extension like a user would and records the window with ffmpeg.
 * Writes <JPT_DEMO_OUT>/raw.mp4 and <JPT_DEMO_OUT>/captions.json (caption times relative to the recording).
 */
import { ChildProcessWithoutNullStreams, execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { JpaPowerToolsApi } from '../../extension';
import { ConnectionConfig } from '../../model/types';
import { ConnectionNode, SchemaNode, TableNode } from '../../views/DatabaseExplorer';
import { GeneratorPanel, UiOptions } from '../../webview/GeneratorPanel';

const OUT = process.env.JPT_DEMO_OUT!;
const WINDOW_TITLE = 'JPA Power Tools Demo';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const cmd = (id: string, ...args: unknown[]) => vscode.commands.executeCommand(id, ...args);

async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
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

interface Bounds { x: number; y: number; width: number; height: number }

/**
 * Moves the demo window to a secondary monitor when there is one (Windows shows toast notifications on the
 * primary display only, so other applications' notifications stay out of the recording), maximizes it,
 * brings it to the front and returns its visible bounds in physical pixels.
 */
function focusWindow(): Bounds {
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices;
public class W {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int size);
}
"@
[W]::SetProcessDPIAware() | Out-Null
$p = Get-Process | Where-Object { $_.MainWindowTitle -like '*${WINDOW_TITLE}*' } | Select-Object -First 1
if (-not $p) { Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { Write-Output ("WINDOW: " + $_.MainWindowTitle) }; exit 3 }
$h = $p.MainWindowHandle
$screen = [System.Windows.Forms.Screen]::AllScreens | Where-Object { -not $_.Primary } | Select-Object -First 1
$secondary = [bool]$screen
if (-not $screen) { $screen = [System.Windows.Forms.Screen]::PrimaryScreen }
$a = $screen.WorkingArea
[W]::ShowWindow($h, 9) | Out-Null
[W]::SetWindowPos($h, [IntPtr]::Zero, $a.X + 40, $a.Y + 40, 1200, 800, 0x0040) | Out-Null
Start-Sleep -Milliseconds 300
[W]::ShowWindow($h, 3) | Out-Null
[W]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 800
$r = New-Object W+RECT
[W]::DwmGetWindowAttribute($h, 9, [ref]$r, 16) | Out-Null
Write-Output ("{0},{1},{2},{3},{4}" -f $r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top), $secondary)`;
  let out: string;
  try {
    out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true }).toString().trim();
  } catch (e) {
    throw new Error(`Demo window not found. Open windows:\n${(e as { stdout?: Buffer }).stdout?.toString()}`);
  }
  const [x, y, width, height, secondary] = out.split(/\r?\n/).pop()!.split(',');
  if (secondary !== 'True') {
    console.warn('No secondary monitor: recording on the primary display, where notifications can appear. Review the video before publishing.');
  }
  const w = Number(width);
  const h = Number(height);
  return { x: Number(x), y: Number(y), width: w - (w % 2), height: h - (h % 2) };
}

class Recorder {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private t0 = 0;
  readonly captions: Array<{ text: string; start: number; end: number }> = [];

  /** Records the window's screen area at a constant 30 fps (wall-clock timeline, so captions stay in sync). */
  async start(file: string, b: Bounds): Promise<void> {
    this.proc = spawn('ffmpeg', [
      '-y', '-f', 'gdigrab', '-framerate', '30', '-draw_mouse', '0',
      '-offset_x', String(b.x), '-offset_y', String(b.y), '-video_size', `${b.width}x${b.height}`, '-i', 'desktop',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-pix_fmt', 'yuv420p', file,
    ], { windowsHide: true });
    let log = '';
    let opened = false;
    this.proc.stderr.on('data', (d: Buffer) => {
      const text = d.toString();
      log = (log + text).slice(-2000);
      if (!opened && /Output #0/.test(text)) {
        opened = true;
        this.t0 = Date.now();
      }
    });
    let exited = false;
    this.proc.on('exit', () => (exited = true));
    await waitFor(() => opened || exited, 20_000).catch(() => undefined);
    if (exited || !opened) {
      throw new Error(`ffmpeg could not capture the screen:\n${log}`);
    }
  }

  private now(): number {
    return (Date.now() - this.t0) / 1000;
  }

  caption(text: string): void {
    this.endCaption();
    this.captions.push({ text, start: this.now(), end: -1 });
  }

  endCaption(): void {
    const last = this.captions[this.captions.length - 1];
    if (last && last.end < 0) {
      last.end = this.now();
    }
  }

  async stop(): Promise<void> {
    this.endCaption();
    const p = this.proc!;
    const exited = new Promise(r => p.once('exit', r));
    p.stdin.write('q');
    await exited;
  }
}

async function typeText(text: string, delay = 45): Promise<void> {
  for (const ch of text) {
    await cmd('type', { text: ch });
    await sleep(ch === ' ' ? delay * 1.5 : delay);
  }
}

function moveTo(editor: vscode.TextEditor, needle: string, offset = 0, occurrence = 0): void {
  const text = editor.document.getText();
  let idx = -1;
  for (let i = 0; i <= occurrence; i++) {
    idx = text.indexOf(needle, idx + 1);
  }
  const pos = editor.document.positionAt(idx + offset);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

const conn = (c: Partial<ConnectionConfig>): ConnectionConfig => ({
  id: c.kind!, name: c.name!, host: 'localhost', port: 0, database: '', user: '', ssl: false, savePassword: true, ...c,
} as ConnectionConfig);

suite('Demo', () => {
  test('record', async function () {
    this.timeout(15 * 60_000);
    const api = await vscode.extensions.getExtension<JpaPowerToolsApi>('izzyjere.jpa-powertools')!.activate();
    for (const c of api.store.list()) {
      await api.store.remove(c.id);
    }
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;

    // ---- stage
    await cmd('workbench.action.closeAllEditors');
    await cmd('workbench.action.closeAuxiliaryBar');
    await cmd('workbench.action.closePanel');
    await cmd('workbench.view.extension.jpaPowertools');
    await cmd('notifications.clearAll');
    await sleep(1500);
    const bounds = focusWindow();
    await sleep(1200);

    const rec = new Recorder();
    await rec.start(path.join(OUT, 'raw.mp4'), bounds);
    await sleep(800);

    // ---- 1. Connect
    rec.caption('Import a connection straight from application.properties');
    await sleep(1200);
    await cmd('jpaPowertools.importSpringDatasource');
    await waitFor(() => vscode.window.tabGroups.all.flatMap(g => g.tabs).find(t => t.label === 'New Connection'));
    await sleep(4500);
    await cmd('workbench.action.closeActiveEditor');

    rec.caption('PostgreSQL, MySQL, SQL Server, Oracle, Db2 and any JDBC database');
    const pg = conn({ kind: 'postgresql', name: 'Shop · PostgreSQL', port: 55432, database: 'shop', user: 'postgres' });
    await api.store.save(pg, 'secret');
    await sleep(600);
    await api.store.save(conn({ kind: 'mysql', name: 'Shop · MySQL', port: 53306, database: 'shop', user: 'root' }), 'secret');
    await sleep(500);
    await api.store.save(conn({ kind: 'sqlserver', name: 'Shop · SQL Server', port: 51433, database: 'shop', user: 'sa' }), 'Secret#2026');
    await sleep(500);
    await api.store.save(conn({ kind: 'oracle', name: 'Shop · Oracle', port: 51521, database: 'FREEPDB1', user: 'shop' }), 'secret');
    await sleep(1200);

    const roots = await api.explorer.getChildren() as ConnectionNode[];
    const oracle = roots.find(r => r.config.kind === 'oracle')!;
    await api.view.reveal(oracle, { expand: true, select: true, focus: true });
    await sleep(2200);
    await cmd('workbench.actions.treeView.jpaPowertools.explorer.collapseAll');
    await sleep(500);

    rec.caption('Browse schemas, tables, keys and column types');
    const pgNode = (await api.explorer.getChildren() as ConnectionNode[]).find(r => r.config.kind === 'postgresql')!;
    await api.view.reveal(pgNode, { expand: true, select: true, focus: true });
    await sleep(1200);
    const [publicSchema] = await api.explorer.getChildren(pgNode) as SchemaNode[];
    await api.view.reveal(publicSchema, { expand: true, select: true });
    await sleep(1200);
    const tables = await api.explorer.getChildren(publicSchema) as TableNode[];
    const customers = tables.find(t => t.table.name === 'customers')!;
    await api.view.reveal(customers, { expand: true, select: true });
    await sleep(4000);

    // ---- 2. Generate entities
    await cmd('notifications.clearAll');
    rec.caption('Generate JPA entities and Spring Data repositories, with a live preview');
    const wanted = ['orders', 'customers', 'order_items', 'products', 'categories', 'customer_profiles'];
    const selected = wanted.map(n => tables.find(t => t.table.name === n)!);
    await cmd('jpaPowertools.generateEntities', selected[0], selected);
    const panel = await waitFor(() => GeneratorPanel.panels()[0]);
    const init = await waitFor(() => panel.lastPosted.get('init') as { options: UiOptions } | undefined);
    await waitFor(() => panel.lastPosted.get('preview'));
    await sleep(8000);

    rec.caption('Foreign keys become lazy associations; composite keys, @Version and Lombok included');
    await panel.handle({ type: 'generate', tables: wanted, options: { ...init.options } });
    await waitFor(() => panel.lastPosted.get('generated'));
    await sleep(3000);
    await cmd('notifications.clearAll');
    const orderFile = path.join(init.options.sourceRoot, 'com', 'acme', 'shop', 'entity', 'Order.java');
    const orderEditor = await vscode.window.showTextDocument(vscode.Uri.file(orderFile), { preview: false });
    await sleep(2000);
    for (let i = 0; i < 14; i++) {
      await cmd('editorScroll', { to: 'down', by: 'line', value: 1 });
      await sleep(120);
    }
    await sleep(3000);
    void orderEditor;

    // ---- 3. JPQL
    await cmd('notifications.clearAll');
    rec.caption('Write JPQL with completion from your entities');
    const repoFile = path.join(init.options.sourceRoot, 'com', 'acme', 'shop', 'repository', 'OrderRepository.java');
    fs.writeFileSync(repoFile, [
      'package com.acme.shop.repository;',
      '',
      'import com.acme.shop.entity.Order;',
      'import org.springframework.data.jpa.repository.JpaRepository;',
      'import org.springframework.data.jpa.repository.Query;',
      'import org.springframework.data.repository.query.Param;',
      '',
      'import java.util.List;',
      '',
      'public interface OrderRepository extends JpaRepository<Order, Long> {',
      '',
      '    ',
      '}',
      '',
    ].join('\n'));
    await sleep(800);
    const repo = await vscode.window.showTextDocument(vscode.Uri.file(repoFile), { preview: false });
    await api.jpql.index.whenReady();
    await waitFor(() => api.jpql.index.model.entity('Order'));
    moveTo(repo, '    \n}', 4);
    await sleep(800);
    await typeText('@Query("select o from Order o where o.customer.');
    await sleep(2800);
    await cmd('hideSuggestWidget');

    rec.caption('Mistakes are caught as you type, with quick fixes');
    await typeText('emial = :email")');
    await sleep(1500);
    moveTo(repo, 'emial', 2);
    await cmd('editor.action.showHover');
    await sleep(3200);
    await cmd('editor.action.hideHover');
    await sleep(300);
    await cmd('editor.action.quickFix');
    await sleep(1600);
    await cmd('acceptSelectedCodeAction');
    await sleep(1200);
    moveTo(repo, ':email")', ':email")'.length);
    await typeText('\nList<Order> findByCustomerEmail(@Param("email") String email);', 30);
    await sleep(1200);

    rec.caption('Jump from a query straight to the entity field');
    moveTo(repo, 'o.customer.email', 4);
    await cmd('editor.action.peekDefinition');
    await sleep(3800);
    await cmd('closeReferenceSearch');
    await sleep(600);

    rec.caption('Hover any path to see the attribute and its type');
    moveTo(repo, 'o.customer.email', 13);
    await cmd('editor.action.showHover');
    await sleep(3500);
    await cmd('editor.action.hideHover');
    await sleep(400);
    await cmd('notifications.clearAll');

    rec.caption('Convert Spring Data derived queries into explicit JPQL');
    moveTo(repo, 'String email);', 'String email);'.length);
    await typeText('\n\nList<Order> findByCustomerFullNameIgnoreCaseOrderByPlacedAtDesc(String name);', 30);
    await sleep(800);
    moveTo(repo, 'findByCustomerFullName', 6);
    await cmd('editor.action.refactor');
    await sleep(2000);
    await cmd('acceptSelectedCodeAction');
    await sleep(4500);

    rec.caption('All commands live under “JPA Power Tools”');
    await cmd('workbench.action.quickOpen', '>JPA Power Tools: ');
    await sleep(3500);
    await cmd('workbench.action.closeQuickOpen');
    rec.endCaption();
    await sleep(1000);

    await rec.stop();
    fs.writeFileSync(path.join(OUT, 'captions.json'), JSON.stringify(rec.captions, null, 2));
    void root;
  });
});
