/**
 * Find-references provider.
 * Finds every place in the workspace where a symbol is used.
 */

import { Location, Position, Range as LspRange } from 'vscode-languageserver/node.js';
import type { CausetDocument, Range } from 'causet-shared';
import { WorkspaceIndex } from 'causet-shared';

function toRange(r: Range): LspRange {
  return {
    start: { line: r.start.line, character: r.start.character },
    end: { line: r.end.line, character: r.end.character },
  };
}

function wordAt(text: string, position: Position): string | null {
  const lines = text.split('\n');
  const line = lines[position.line] ?? '';
  const ch = position.character;
  let start = ch;
  let end = ch;
  while (start > 0 && /[A-Za-z0-9_]/.test(line[start - 1])) start--;
  while (end < line.length && /[A-Za-z0-9_]/.test(line[end])) end++;
  return line.slice(start, end) || null;
}

export function provideReferences(
  doc: CausetDocument,
  position: Position,
  index: WorkspaceIndex,
): Location[] {
  const word = wordAt(doc.text, position);
  if (!word) return [];

  const refs = index.findReferences(word);
  return refs.map((r) => Location.create(r.uri, toRange(r.range)));
}
