/**
 * Rename provider.
 * Renaming a symbol updates every reference across the workspace.
 */

import {
  WorkspaceEdit,
  TextEdit,
  Position,
  Range as LspRange,
} from 'vscode-languageserver/node.js';
import type { CausetDocument, Range } from 'causet-shared';
import { WorkspaceIndex } from 'causet-shared';

function toRange(r: Range): LspRange {
  return {
    start: { line: r.start.line, character: r.start.character },
    end: { line: r.end.line, character: r.end.character },
  };
}

function wordAt(text: string, position: Position): { word: string; range: LspRange } | null {
  const lines = text.split('\n');
  const line = lines[position.line] ?? '';
  const ch = position.character;
  let start = ch;
  let end = ch;
  while (start > 0 && /[A-Za-z0-9_]/.test(line[start - 1])) start--;
  while (end < line.length && /[A-Za-z0-9_]/.test(line[end])) end++;
  const word = line.slice(start, end);
  if (!word) return null;
  return {
    word,
    range: { start: { line: position.line, character: start }, end: { line: position.line, character: end } },
  };
}

export interface RenameResult {
  prepareRange?: LspRange;
  workspaceEdit?: WorkspaceEdit;
}

export function provideRename(
  doc: CausetDocument,
  position: Position,
  index: WorkspaceIndex,
  newName?: string,
): RenameResult {
  const w = wordAt(doc.text, position);
  if (!w) return {};

  const { word, range } = w;

  // prepareRename just returns the word range
  if (!newName) {
    return { prepareRange: range };
  }

  // Validate new name
  const isScreaming = /^[A-Z][A-Z0-9_]*$/.test(word);
  const isSnake = /^[a-z][a-z0-9_]*$/.test(word);

  if (isScreaming && !/^[A-Z][A-Z0-9_]*$/.test(newName)) {
    // event/action names must remain SCREAMING_SNAKE
    return {};
  }
  if (isSnake && !/^[a-z][a-z0-9_]*$/.test(newName)) {
    // entity/projection names must remain snake_case
    return {};
  }

  // Find all references
  const refs = index.findReferences(word);

  // Build workspace edit
  const changes: Record<string, TextEdit[]> = {};
  for (const ref of refs) {
    if (!changes[ref.uri]) changes[ref.uri] = [];
    changes[ref.uri].push(TextEdit.replace(toRange(ref.range), newName));
  }

  return { workspaceEdit: { changes } };
}
