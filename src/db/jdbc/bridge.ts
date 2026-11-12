import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as path from 'path';
import { JdbcRuntime } from './runtime';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** Client for the line-delimited JSON protocol spoken by `JdbcBridge.java`. */
export class BridgeProcess {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private stdoutBuf = '';
  private stderrTail = '';
  private exited = false;

  constructor(runtime: JdbcRuntime) {
    const args = [
      '-Dfile.encoding=UTF-8',
      '-Xshare:auto',
      '-XX:TieredStopAtLevel=1',
      ...(runtime.classpath.length ? ['-cp', runtime.classpath.join(path.delimiter)] : []),
      runtime.bridgeSource,
    ];
    this.proc = spawn(runtime.javaPath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.proc.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });
    this.proc.on('error', err => this.fail(err));
    this.proc.on('exit', code => this.fail(new Error(this.exitMessage(code))));
    this.proc.stdin.on('error', () => undefined);
  }

  private exitMessage(code: number | null): string {
    const tail = this.stderrTail.trim();
    const lines = tail.split(/\r?\n/).filter(l => l.trim() && !/^\s+at /.test(l));
    const relevant = lines.slice(-3).join(' ');
    return relevant ? `JDBC bridge stopped: ${relevant}` : `JDBC bridge exited with code ${code}`;
  }

  private onStdout(chunk: string) {
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.substring(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.substring(nl + 1);
      if (!line) {
        continue;
      }
      let msg: { id: number; ok: boolean; result?: unknown; error?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const p = this.pending.get(msg.id);
      if (!p) {
        continue;
      }
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) {
        p.resolve(msg.result);
      } else {
        p.reject(new Error(msg.error ?? 'Unknown JDBC error'));
      }
    }
  }

  private fail(err: Error) {
    this.exited = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  request<T>(op: string, params: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<T> {
    if (this.exited) {
      return Promise.reject(new Error(this.exitMessage(this.proc.exitCode)));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JDBC bridge timed out on "${op}"`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.proc.stdin.write(JSON.stringify({ id, op, ...params }) + '\n');
    });
  }

  async close(): Promise<void> {
    if (this.exited) {
      return;
    }
    const done = new Promise<void>(resolve => this.proc.once('exit', () => resolve()));
    this.request('close', {}, 3000).catch(() => undefined);
    const killer = setTimeout(() => this.proc.kill(), 3000);
    await done;
    clearTimeout(killer);
  }
}
