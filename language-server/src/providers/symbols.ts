/**
 * Document symbol provider — populates the Outline view.
 */

import { DocumentSymbol, SymbolKind, Range as LspRange } from 'vscode-languageserver/node.js';
import type { CausetDocument, Range } from 'causet-shared';

function toRange(r: Range): LspRange {
  return {
    start: { line: r.start.line, character: r.start.character },
    end: { line: r.end.line, character: r.end.character },
  };
}

export function provideDocumentSymbols(doc: CausetDocument): DocumentSymbol[] {
  const roots: DocumentSymbol[] = [];

  // State
  if (doc.state && Object.keys(doc.state).length > 0) {
    const sectionRange = toRange(Object.values(doc.state)[0].range);
    const stateSection: DocumentSymbol = {
      name: 'state',
      kind: SymbolKind.Namespace,
      range: sectionRange,
      selectionRange: sectionRange,
      children: [],
    };
    for (const [name, ent] of Object.entries(doc.state)) {
      const r = toRange(ent.range);
      const entSym: DocumentSymbol = {
        name,
        detail: ent.entityKey ? `entity_key: ${ent.entityKey}` : undefined,
        kind: SymbolKind.Struct,
        range: r,
        selectionRange: r,
        children: ent.fields.map((f) => ({
          name: f.name,
          detail: f.type ?? 'any',
          kind: SymbolKind.Field,
          range: toRange(f.range),
          selectionRange: toRange(f.range),
        })),
      };
      stateSection.children!.push(entSym);
    }
    roots.push(stateSection);
  }

  // Events
  if (doc.events && Object.keys(doc.events).length > 0) {
    const evSection: DocumentSymbol = {
      name: 'events',
      kind: SymbolKind.Namespace,
      range: toRange(Object.values(doc.events)[0].range),
      selectionRange: toRange(Object.values(doc.events)[0].range),
      children: [],
    };
    for (const [name, ev] of Object.entries(doc.events)) {
      const r = toRange(ev.range);
      evSection.children!.push({
        name,
        detail: ev.state ? `→ ${ev.state}` : undefined,
        kind: SymbolKind.Event,
        range: r,
        selectionRange: r,
        children: Object.keys(ev.payload ?? {}).map((f) => ({
          name: f,
          detail: typeof ev.payload![f] === 'string' ? ev.payload![f] as string : undefined,
          kind: SymbolKind.Field,
          range: r,
          selectionRange: r,
        })),
      });
    }
    roots.push(evSection);
  }

  // Actions
  if (doc.actions && Object.keys(doc.actions).length > 0) {
    const actSection: DocumentSymbol = {
      name: 'actions',
      kind: SymbolKind.Namespace,
      range: toRange(Object.values(doc.actions)[0].range),
      selectionRange: toRange(Object.values(doc.actions)[0].range),
      children: [],
    };
    for (const [name, act] of Object.entries(doc.actions)) {
      const r = toRange(act.range);
      actSection.children!.push({
        name,
        detail: act.state ? `→ ${act.state}` : undefined,
        kind: SymbolKind.Method,
        range: r,
        selectionRange: r,
        children: Object.keys(act.input ?? {}).map((f) => ({
          name: f,
          detail: act.input![f].type,
          kind: SymbolKind.Field,
          range: r,
          selectionRange: r,
        })),
      });
    }
    roots.push(actSection);
  }

  // Projections
  if (doc.projections && Object.keys(doc.projections).length > 0) {
    const projSection: DocumentSymbol = {
      name: 'projections',
      kind: SymbolKind.Namespace,
      range: toRange(Object.values(doc.projections)[0].range),
      selectionRange: toRange(Object.values(doc.projections)[0].range),
      children: [],
    };
    for (const [name, proj] of Object.entries(doc.projections)) {
      const r = toRange(proj.range);
      projSection.children!.push({
        name,
        detail: proj.target.table ? `→ ${proj.target.table}` : undefined,
        kind: SymbolKind.Class,
        range: r,
        selectionRange: r,
        children: Object.keys(proj.fields ?? {}).map((col) => ({
          name: col,
          detail: proj.fields![col],
          kind: SymbolKind.Field,
          range: r,
          selectionRange: r,
        })),
      });
    }
    roots.push(projSection);
  }

  // Queries
  if (doc.queries && Object.keys(doc.queries).length > 0) {
    const qSection: DocumentSymbol = {
      name: 'queries',
      kind: SymbolKind.Namespace,
      range: toRange(Object.values(doc.queries)[0].range),
      selectionRange: toRange(Object.values(doc.queries)[0].range),
      children: [],
    };
    for (const [name, q] of Object.entries(doc.queries)) {
      const r = toRange(q.range);
      qSection.children!.push({
        name,
        detail: q.from ? `from: ${q.from}` : undefined,
        kind: SymbolKind.Function,
        range: r,
        selectionRange: r,
      });
    }
    roots.push(qSection);
  }

  // Relationships
  if (doc.relationships && Object.keys(doc.relationships).length > 0) {
    const relSection: DocumentSymbol = {
      name: 'relationships',
      kind: SymbolKind.Namespace,
      range: toRange(Object.values(doc.relationships)[0].range),
      selectionRange: toRange(Object.values(doc.relationships)[0].range),
      children: [],
    };
    for (const [name, rel] of Object.entries(doc.relationships)) {
      const r = toRange(rel.range);
      relSection.children!.push({
        name,
        detail: `${rel.from} → ${rel.to}`,
        kind: SymbolKind.Interface,
        range: r,
        selectionRange: r,
      });
    }
    roots.push(relSection);
  }

  // Listeners
  if (doc.listeners && doc.listeners.length > 0) {
    const listSection: DocumentSymbol = {
      name: 'listeners',
      kind: SymbolKind.Namespace,
      range: toRange(doc.listeners[0].range),
      selectionRange: toRange(doc.listeners[0].range),
      children: doc.listeners.map((l) => ({
        name: `on: ${l.on}`,
        kind: SymbolKind.Event,
        range: toRange(l.range),
        selectionRange: toRange(l.range),
      })),
    };
    roots.push(listSection);
  }

  // Prompts
  if (doc.prompts && Object.keys(doc.prompts).length > 0) {
    const section: DocumentSymbol = {
      name: 'prompts',
      kind: SymbolKind.Namespace,
      range: toRange(Object.values(doc.prompts)[0].range),
      selectionRange: toRange(Object.values(doc.prompts)[0].range),
      children: [],
    };
    for (const [name, prompt] of Object.entries(doc.prompts)) {
      const r = toRange(prompt.range);
      section.children!.push({ name, kind: SymbolKind.String, range: r, selectionRange: r });
    }
    roots.push(section);
  }

  // Decisions
  if (doc.decisions && Object.keys(doc.decisions).length > 0) {
    const section: DocumentSymbol = {
      name: 'decisions',
      kind: SymbolKind.Namespace,
      range: toRange(Object.values(doc.decisions)[0].range),
      selectionRange: toRange(Object.values(doc.decisions)[0].range),
      children: [],
    };
    for (const [name, decision] of Object.entries(doc.decisions)) {
      const r = toRange(decision.range);
      section.children!.push({
        name,
        detail: decision.emits
          ? `emits: ${decision.emits}`
          : decision.provider ?? decision.executor,
        kind: SymbolKind.Function,
        range: r,
        selectionRange: r,
      });
    }
    roots.push(section);
  }

  // Memories
  if (doc.memories && Object.keys(doc.memories).length > 0) {
    const section: DocumentSymbol = {
      name: 'memories',
      kind: SymbolKind.Namespace,
      range: toRange(Object.values(doc.memories)[0].range),
      selectionRange: toRange(Object.values(doc.memories)[0].range),
      children: [],
    };
    for (const [name, memory] of Object.entries(doc.memories)) {
      const r = toRange(memory.range);
      section.children!.push({
        name,
        detail: memory.partitionBy ? `partition: ${memory.partitionBy}` : undefined,
        kind: SymbolKind.Object,
        range: r,
        selectionRange: r,
      });
    }
    roots.push(section);
  }

  // Providers
  if (doc.providers && Object.keys(doc.providers).length > 0) {
    const section: DocumentSymbol = {
      name: 'providers',
      kind: SymbolKind.Namespace,
      range: toRange(Object.values(doc.providers)[0].range),
      selectionRange: toRange(Object.values(doc.providers)[0].range),
      children: [],
    };
    for (const [name, provider] of Object.entries(doc.providers)) {
      const r = toRange(provider.range);
      section.children!.push({
        name,
        detail: provider.executor ? `executor: ${provider.executor}` : undefined,
        kind: SymbolKind.Interface,
        range: r,
        selectionRange: r,
      });
    }
    roots.push(section);
  }

  // Sagas
  if (doc.sagas && Object.keys(doc.sagas).length > 0) {
    const sagaSection: DocumentSymbol = {
      name: 'sagas',
      kind: SymbolKind.Namespace,
      range: toRange(Object.values(doc.sagas)[0].range),
      selectionRange: toRange(Object.values(doc.sagas)[0].range),
      children: [],
    };
    for (const [name, saga] of Object.entries(doc.sagas)) {
      const r = toRange(saga.range);
      sagaSection.children!.push({
        name,
        detail: `state: ${saga.state}`,
        kind: SymbolKind.Object,
        range: r,
        selectionRange: r,
      });
    }
    roots.push(sagaSection);
  }

  return roots;
}
