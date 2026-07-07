/**
 * Causet VS Code Extension — entry point.
 *
 * Starts the language server as a separate Node.js process communicating over
 * stdio, then connects the VS Code LSP client to it. All language features
 * (hover, completion, go-to-definition, rename, diagnostics, etc.) flow
 * through the language server.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node.js';

let client: LanguageClient;

const CAUSET_FILE_EXCLUDE = '**/{node_modules,.git,dist}/**';

async function indexWorkspaceCausetFiles(): Promise<number> {
  const files = await vscode.workspace.findFiles('**/*.causet', CAUSET_FILE_EXCLUDE);
  const payloads: Array<{ uri: string; text: string }> = [];

  for (const uri of files) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      payloads.push({ uri: uri.toString(), text: Buffer.from(bytes).toString('utf8') });
    } catch {
      // skip unreadable files
    }
  }

  if (payloads.length > 0) {
    await client.sendNotification('causet/indexWorkspace', { files: payloads });
  }

  return payloads.length;
}

export function activate(context: vscode.ExtensionContext): void {
  // Path to the compiled language server entry point
  const serverModule = context.asAbsolutePath(
    path.join('dist', 'server', 'server.js'),
  );

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.stdio },
    debug: {
      module: serverModule,
      transport: TransportKind.stdio,
      options: { execArgv: ['--nolazy', '--inspect=6009'] },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'causet' }],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.causet'),
    },
    markdown: { isTrusted: true },
  };

  client = new LanguageClient(
    'causet',
    'Causet Language Server',
    serverOptions,
    clientOptions,
  );

  // Register the "Validate Workspace" command
  context.subscriptions.push(
    vscode.commands.registerCommand('causet.validateWorkspace', async () => {
      const count = await indexWorkspaceCausetFiles();
      vscode.window.showInformationMessage(
        `Causet: indexed ${count} .causet file(s) and refreshed diagnostics.`,
      );
    }),
  );

  // Register "Restart Language Server" command
  context.subscriptions.push(
    vscode.commands.registerCommand('causet.restartServer', async () => {
      await client.stop();
      await client.start();
      await indexWorkspaceCausetFiles();
      vscode.window.showInformationMessage('Causet: language server restarted.');
    }),
  );

  // Register "Show Symbol Index" command
  context.subscriptions.push(
    vscode.commands.registerCommand('causet.showSymbolIndex', async () => {
      vscode.window.showInformationMessage('Causet: open the workspace symbol picker (⌘T) to search all events, projections, actions, and more.');
    }),
  );

  void (async () => {
    await client.start();
    await indexWorkspaceCausetFiles();
  })();
  context.subscriptions.push(client);
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
