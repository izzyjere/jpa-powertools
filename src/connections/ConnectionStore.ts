import * as vscode from 'vscode';
import { ConnectionConfig } from '../model/types';

const STATE_KEY = 'jpaPowertools.connections';
const secretKey = (id: string) => `jpaPowertools.password.${id}`;

/** Persists connection settings in global state and passwords in VS Code's SecretStorage. */
export class ConnectionStore implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  list(): ConnectionConfig[] {
    return [...this.context.globalState.get<ConnectionConfig[]>(STATE_KEY, [])].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): ConnectionConfig | undefined {
    return this.list().find(c => c.id === id);
  }

  /**
   * Inserts or updates a connection.
   * @param password `undefined` keeps the stored password; a string replaces it.
   */
  async save(config: ConnectionConfig, password: string | undefined): Promise<void> {
    const all = this.context.globalState.get<ConnectionConfig[]>(STATE_KEY, []).filter(c => c.id !== config.id);
    all.push(config);
    await this.context.globalState.update(STATE_KEY, all);
    if (!config.savePassword) {
      await this.context.secrets.delete(secretKey(config.id));
    } else if (password !== undefined) {
      await this.context.secrets.store(secretKey(config.id), password);
    }
    this.emitter.fire();
  }

  async remove(id: string): Promise<void> {
    const all = this.context.globalState.get<ConnectionConfig[]>(STATE_KEY, []).filter(c => c.id !== id);
    await this.context.globalState.update(STATE_KEY, all);
    await this.context.secrets.delete(secretKey(id));
    this.emitter.fire();
  }

  async getPassword(id: string): Promise<string | undefined> {
    return this.context.secrets.get(secretKey(id));
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

export function newConnectionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 10)}`;
}
