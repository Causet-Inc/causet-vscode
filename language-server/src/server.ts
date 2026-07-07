/**
 * Causet Language Server — main entry point.
 *
 * Implements the full Language Server Protocol using vscode-languageserver.
 * All features operate on the shared AST produced by causet-shared.
 */

import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  DidChangeConfigurationNotification,
  TextDocumentSyncKind,
  InitializeResult,
  SemanticTokensRegistrationOptions,
  SemanticTokensRegistrationType,
  DocumentSymbolParams,
  HoverParams,
  CompletionParams,
  DefinitionParams,
  ReferenceParams,
  RenameParams,
  CodeLensParams,
  FoldingRangeParams,
  WorkspaceSymbolParams,
  DocumentFormattingParams,
  TextEdit,
  FileChangeType,
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WorkspaceIndex } from 'causet-shared';
import { provideDocumentSymbols } from './providers/symbols.js';
import { provideHover } from './providers/hover.js';
import { provideCompletions } from './providers/completion.js';
import { provideDefinition } from './providers/definition.js';
import { provideReferences } from './providers/references.js';
import { provideRename } from './providers/rename.js';
import { provideCodeLens } from './providers/codelens.js';
import { provideFoldingRanges } from './providers/folding.js';
import { provideSemanticTokens, SEMANTIC_TOKEN_TYPES, SEMANTIC_TOKEN_MODIFIERS } from './providers/semantic-tokens.js';
import { provideDiagnostics } from './providers/diagnostics.js';
import { provideWorkspaceSymbols } from './providers/workspace-symbols.js';
import { provideFormatting } from './providers/formatting.js';

// ---------------------------------------------------------------------------
// Connection & document manager setup
// ---------------------------------------------------------------------------

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const index = new WorkspaceIndex();

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const capabilities = params.capabilities;

  hasConfigurationCapability = !!(
    capabilities.workspace && !!capabilities.workspace.configuration
  );
  hasWorkspaceFolderCapability = !!(
    capabilities.workspace && !!capabilities.workspace.workspaceFolders
  );

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: [':', ' ', '.', '-', '\n'],
      },
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: { prepareProvider: true },
      documentSymbolProvider: true,
      workspaceSymbolProvider: { resolveProvider: false },
      codeLensProvider: { resolveProvider: false },
      foldingRangeProvider: true,
      documentFormattingProvider: true,
      semanticTokensProvider: {
        legend: {
          tokenTypes: SEMANTIC_TOKEN_TYPES,
          tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
        },
        full: true,
        range: false,
      },
    },
  };

  if (hasWorkspaceFolderCapability) {
    result.capabilities.workspace = {
      workspaceFolders: { supported: true },
    };
  }

  return result;
});

connection.onInitialized(() => {
  if (hasConfigurationCapability) {
    connection.client.register(DidChangeConfigurationNotification.type, undefined);
  }
});

// ---------------------------------------------------------------------------
// Document lifecycle — parse on every change and push diagnostics
// ---------------------------------------------------------------------------

documents.onDidOpen((e) => {
  refreshDocument(e.document);
});

documents.onDidChangeContent((e) => {
  refreshDocument(e.document);
});

documents.onDidClose((e) => {
  index.remove(e.document.uri);
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

function refreshDocument(document: TextDocument): void {
  const result = index.update(document.uri, document.getText(), document.version);
  const diags = provideDiagnostics(result.document, index);
  connection.sendDiagnostics({ uri: document.uri, diagnostics: diags });
}

function refreshAllOpenDocuments(): void {
  for (const doc of documents.all()) {
    refreshDocument(doc);
  }
}

function indexFileFromDisk(uri: string): void {
  try {
    const path = fileURLToPath(uri);
    const text = readFileSync(path, 'utf8');
    index.update(uri, text);
  } catch {
    // File may not exist yet or be unreadable
  }
}

/** Bulk-index workspace files sent by the extension on startup. */
connection.onNotification(
  'causet/indexWorkspace',
  (params: { files: Array<{ uri: string; text: string }> }) => {
    for (const f of params.files) {
      index.update(f.uri, f.text);
    }
    refreshAllOpenDocuments();
  },
);

connection.onDidChangeWatchedFiles((params) => {
  for (const change of params.changes) {
    if (change.type === FileChangeType.Deleted) {
      index.remove(change.uri);
    } else {
      indexFileFromDisk(change.uri);
    }
  }
  refreshAllOpenDocuments();
});

// ---------------------------------------------------------------------------
// LSP request handlers
// ---------------------------------------------------------------------------

connection.onDocumentSymbol((params: DocumentSymbolParams) => {
  const doc = index.getDocument(params.textDocument.uri);
  if (!doc) return [];
  return provideDocumentSymbols(doc);
});

connection.onHover((params: HoverParams) => {
  const doc = index.getDocument(params.textDocument.uri);
  if (!doc) return null;
  return provideHover(doc, params.position, index);
});

connection.onCompletion((params: CompletionParams) => {
  const textDoc = documents.get(params.textDocument.uri);
  const doc = index.getDocument(params.textDocument.uri);
  if (!textDoc || !doc) return [];
  return provideCompletions(doc, params.position, textDoc.getText(), index);
});

connection.onDefinition((params: DefinitionParams) => {
  const doc = index.getDocument(params.textDocument.uri);
  if (!doc) return null;
  return provideDefinition(doc, params.position, index);
});

connection.onReferences((params: ReferenceParams) => {
  const doc = index.getDocument(params.textDocument.uri);
  if (!doc) return [];
  return provideReferences(doc, params.position, index);
});

connection.onPrepareRename((params) => {
  const doc = index.getDocument(params.textDocument.uri);
  if (!doc) return null;
  return provideRename(doc, params.position, index).prepareRange ?? null;
});

connection.onRenameRequest((params: RenameParams) => {
  const doc = index.getDocument(params.textDocument.uri);
  if (!doc) return null;
  return provideRename(doc, params.position, index, params.newName).workspaceEdit ?? null;
});

connection.onCodeLens((params: CodeLensParams) => {
  const doc = index.getDocument(params.textDocument.uri);
  if (!doc) return [];
  return provideCodeLens(doc, index);
});

connection.onFoldingRanges((params: FoldingRangeParams) => {
  const textDoc = documents.get(params.textDocument.uri);
  if (!textDoc) return [];
  return provideFoldingRanges(textDoc.getText());
});

connection.onDocumentFormatting((params: DocumentFormattingParams): TextEdit[] => {
  const textDoc = documents.get(params.textDocument.uri);
  if (!textDoc) return [];
  return provideFormatting(textDoc.getText(), params.options);
});

connection.onWorkspaceSymbol((params: WorkspaceSymbolParams) => {
  return provideWorkspaceSymbols(params.query, index);
});

connection.languages.semanticTokens.on((params) => {
  const doc = index.getDocument(params.textDocument.uri);
  const textDoc = documents.get(params.textDocument.uri);
  if (!doc || !textDoc) return { data: [] };
  return provideSemanticTokens(doc, textDoc.getText());
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

documents.listen(connection);
connection.listen();
