/**
 * Workspace symbol search provider (Ctrl+T / ⌘T).
 */

import { SymbolInformation, SymbolKind, Range as LspRange } from 'vscode-languageserver/node.js';
import type { WorkspaceSymbol as CausetSymbol, Range } from 'causet-shared';
import { WorkspaceIndex } from 'causet-shared';

function toRange(r: Range): LspRange {
  return {
    start: { line: r.start.line, character: r.start.character },
    end: { line: r.end.line, character: r.end.character },
  };
}

function toSymbolKind(kind: CausetSymbol['kind']): SymbolKind {
  switch (kind) {
    case 'event':        return SymbolKind.Event;
    case 'action':       return SymbolKind.Method;
    case 'entity':       return SymbolKind.Struct;
    case 'projection':   return SymbolKind.Class;
    case 'query':        return SymbolKind.Function;
    case 'relationship': return SymbolKind.Interface;
    case 'saga':         return SymbolKind.Object;
    case 'resource':     return SymbolKind.Module;
    case 'field':        return SymbolKind.Field;
    default:             return SymbolKind.Variable;
  }
}

export function provideWorkspaceSymbols(query: string, index: WorkspaceIndex): SymbolInformation[] {
  const results = index.searchSymbols(query);
  return results.map((sym) => ({
    name: sym.name,
    kind: toSymbolKind(sym.kind),
    location: { uri: sym.uri, range: toRange(sym.range) },
    containerName: sym.containerName ?? sym.detail,
  }));
}
