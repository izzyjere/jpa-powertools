import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { downloadArtifact, findJava, jarFileName, JdbcRuntime, missingArtifacts } from '../db/jdbc/runtime';
import { ConnectionConfig, dialect } from '../model/types';
import { CancelledError, ConnectionError } from './SessionManager';

/** Resolves Java and JDBC driver jars for JDBC-backed connections, downloading drivers on demand. */
export class JdbcEnvironment {
  private javaPath: Promise<string> | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('jpaPowertools.javaHome')) {
        this.javaPath = undefined;
      }
    }));
  }

  get driversDir(): string {
    return path.join(this.context.globalStorageUri.fsPath, 'drivers');
  }

  private java(): Promise<string> {
    if (!this.javaPath) {
      const home = vscode.workspace.getConfiguration('jpaPowertools').get<string>('javaHome') || undefined;
      this.javaPath = findJava(home);
      this.javaPath.catch(() => (this.javaPath = undefined));
    }
    return this.javaPath;
  }

  async runtimeFor(config: ConnectionConfig): Promise<JdbcRuntime> {
    const d = dialect(config.kind);
    let javaPath: string;
    try {
      javaPath = await this.java();
    } catch (e) {
      throw new ConnectionError(`${d.label} connections use JDBC, which needs Java. ${(e as Error).message}`);
    }

    let classpath: string[];
    if (config.driverJars?.length) {
      const missing = config.driverJars.filter(j => !fs.existsSync(j));
      if (missing.length) {
        throw new ConnectionError(`Driver jar not found: ${missing.join(', ')}. Edit the connection to pick the jar again.`);
      }
      classpath = config.driverJars;
    } else if (d.jdbcArtifacts?.length) {
      classpath = await this.ensureDriver(config);
    } else {
      throw new ConnectionError('Choose the JDBC driver jar for this connection (Edit Connection → Driver jars).');
    }
    return { javaPath, classpath, bridgeSource: this.context.asAbsolutePath(path.join('resources', 'jdbc', 'JdbcBridge.java')) };
  }

  private async ensureDriver(config: ConnectionConfig): Promise<string[]> {
    const d = dialect(config.kind);
    const artifacts = d.jdbcArtifacts!;
    const missing = missingArtifacts(artifacts, this.driversDir);
    if (missing.length) {
      const list = missing.map(a => `${a.group}:${a.artifact}:${a.version}`).join(', ');
      const choice = await vscode.window.showInformationMessage(
        `The ${d.label} JDBC driver is needed to connect.`,
        { modal: true, detail: `Download ${list} from Maven Central? The checksum is verified and the driver is stored for reuse by this extension.` },
        'Download',
        'Use My Own Jar…',
      );
      if (choice === 'Use My Own Jar…') {
        await vscode.commands.executeCommand('jpaPowertools.editConnection', config.id);
        throw new CancelledError();
      }
      if (choice !== 'Download') {
        throw new CancelledError();
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Downloading ${d.label} JDBC driver` },
        async progress => {
          for (const a of missing) {
            progress.report({ message: jarFileName(a) });
            try {
              await downloadArtifact(a, this.driversDir);
            } catch (e) {
              throw new ConnectionError(`Could not download ${jarFileName(a)}: ${(e as Error).message}`);
            }
          }
        },
      );
    }
    return artifacts.map(a => path.join(this.driversDir, jarFileName(a)));
  }
}
