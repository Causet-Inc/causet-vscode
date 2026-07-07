/**
 * Go-to-definition provider.
 * Ctrl+click on an event, action, projection, query, entity, or relationship
 * name navigates to its declaration.
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
  const word = line.slice(start, end);
  return word || null;
}

export function provideDefinition(
  doc: CausetDocument,
  position: Position,
  index: WorkspaceIndex,
): Location | Location[] | null {
  const word = wordAt(doc.text, position);
  if (!word) return null;

  // Events
  const ev = index.resolveEvent(word);
  if (ev) return Location.create(ev.uri, toRange(ev.def.range));

  // Actions
  const act = index.resolveAction(word);
  if (act) return Location.create(act.uri, toRange(act.def.range));

  // Projections
  const proj = index.resolveProjection(word);
  if (proj) return Location.create(proj.uri, toRange(proj.def.range));

  // Queries
  const q = index.resolveQuery(word);
  if (q) return Location.create(q.uri, toRange(q.def.range));

  // Entities
  const ent = index.resolveEntity(word);
  if (ent) return Location.create(ent.uri, toRange(ent.def.range));

  // Relationships
  const rel = index.resolveRelationship(word);
  if (rel) return Location.create(rel.uri, toRange(rel.def.range));

  // AI symbols (snake_case)
  const prompt = index.resolvePrompt(word) ?? (doc.prompts?.[word] ? { def: doc.prompts[word], uri: doc.uri } : undefined);
  if (prompt) return Location.create(prompt.uri, toRange(prompt.def.range));

  const decision = index.resolveDecision(word) ?? (doc.decisions?.[word] ? { def: doc.decisions[word], uri: doc.uri } : undefined);
  if (decision) return Location.create(decision.uri, toRange(decision.def.range));

  const memory = index.resolveMemory(word) ?? (doc.memories?.[word] ? { def: doc.memories[word], uri: doc.uri } : undefined);
  if (memory) return Location.create(memory.uri, toRange(memory.def.range));

  const provider = index.resolveProvider(word) ?? (doc.providers?.[word] ? { def: doc.providers[word], uri: doc.uri } : undefined);
  if (provider) return Location.create(provider.uri, toRange(provider.def.range));

  return null;
}
