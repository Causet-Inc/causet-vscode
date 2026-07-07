/**
 * Causet workspace-level symbol index.
 *
 * Aggregates parsed documents so that cross-file providers (go-to-definition,
 * find-references, rename) can look up symbols by name regardless of which
 * .causet file they live in.
 */

import type { CausetDocument, WorkspaceSymbol, Range, EventDefinition, ActionDefinition, ProjectionDefinition, QueryDefinition, EntityDefinition, RelationshipDefinition, CommitEnvelopeDefinition, PromptDefinition, DecisionDefinition, MemoryDefinition, ProviderDefinition } from './ast.js';
import { parseCausetDocument, type ParseResult } from './parser.js';

export interface DocumentRecord {
  uri: string;
  version: number;
  result: ParseResult;
}

export type SymbolKindFilter =
  | 'event' | 'action' | 'entity' | 'projection' | 'query'
  | 'relationship' | 'saga' | 'resource' | 'commitEnvelope'
  | 'prompt' | 'decision' | 'memory' | 'provider' | 'all';

export class WorkspaceIndex {
  private documents = new Map<string, DocumentRecord>();

  /** Update or add a parsed document. */
  update(uri: string, text: string, version: number = 0): ParseResult {
    const result = parseCausetDocument(uri, text);
    this.documents.set(uri, { uri, version, result });
    return result;
  }

  /** Remove a document (e.g. when file is deleted). */
  remove(uri: string): void {
    this.documents.delete(uri);
  }

  /** Get the parsed document for a URI. */
  getDocument(uri: string): CausetDocument | undefined {
    return this.documents.get(uri)?.result.document;
  }

  /** Get all documents. */
  allDocuments(): CausetDocument[] {
    return [...this.documents.values()].map((r) => r.result.document);
  }

  /** Look up all symbols by name across the workspace. */
  findSymbols(name: string, kindFilter: SymbolKindFilter = 'all'): WorkspaceSymbol[] {
    const results: WorkspaceSymbol[] = [];
    for (const rec of this.documents.values()) {
      for (const sym of rec.result.symbols) {
        if (sym.name === name && (kindFilter === 'all' || sym.kind === kindFilter)) {
          results.push(sym);
        }
      }
    }
    return results;
  }

  /** Find all workspace symbols matching a query (fuzzy, prefix, or exact). */
  searchSymbols(query: string, kindFilter: SymbolKindFilter = 'all'): WorkspaceSymbol[] {
    const lq = query.toLowerCase();
    const results: WorkspaceSymbol[] = [];
    for (const rec of this.documents.values()) {
      for (const sym of rec.result.symbols) {
        if (kindFilter !== 'all' && sym.kind !== kindFilter) continue;
        if (sym.name.toLowerCase().includes(lq)) {
          results.push(sym);
        }
      }
    }
    return results.slice(0, 200); // cap for performance
  }

  /** Return all unique event names across the workspace. */
  allEventNames(): string[] {
    const names = new Set<string>();
    for (const rec of this.documents.values()) {
      const ev = rec.result.document.events;
      if (ev) Object.keys(ev).forEach((n) => names.add(n));
    }
    return [...names].sort();
  }

  /** Return all unique projection names across the workspace. */
  allProjectionNames(): string[] {
    const names = new Set<string>();
    for (const rec of this.documents.values()) {
      const p = rec.result.document.projections;
      if (p) Object.keys(p).forEach((n) => names.add(n));
    }
    return [...names].sort();
  }

  /** Return all unique action names across the workspace. */
  allActionNames(): string[] {
    const names = new Set<string>();
    for (const rec of this.documents.values()) {
      const a = rec.result.document.actions;
      if (a) Object.keys(a).forEach((n) => names.add(n));
    }
    return [...names].sort();
  }

  /** Return all unique entity/state names across the workspace. */
  allEntityNames(): string[] {
    const names = new Set<string>();
    for (const rec of this.documents.values()) {
      const s = rec.result.document.state;
      if (s) Object.keys(s).forEach((n) => names.add(n));
    }
    return [...names].sort();
  }

  /** Return all unique query names across the workspace. */
  allQueryNames(): string[] {
    const names = new Set<string>();
    for (const rec of this.documents.values()) {
      const q = rec.result.document.queries;
      if (q) Object.keys(q).forEach((n) => names.add(n));
    }
    return [...names].sort();
  }

  /** Return all unique relationship names across the workspace. */
  allRelationshipNames(): string[] {
    const names = new Set<string>();
    for (const rec of this.documents.values()) {
      const r = rec.result.document.relationships;
      if (r) Object.keys(r).forEach((n) => names.add(n));
    }
    return [...names].sort();
  }

  /** Resolve an event definition by name. Returns the first match. */
  resolveEvent(name: string): { def: EventDefinition; uri: string } | undefined {
    for (const rec of this.documents.values()) {
      const ev = rec.result.document.events?.[name];
      if (ev) return { def: ev, uri: rec.uri };
    }
    return undefined;
  }

  /** Resolve a projection definition by name. */
  resolveProjection(name: string): { def: ProjectionDefinition; uri: string } | undefined {
    for (const rec of this.documents.values()) {
      const p = rec.result.document.projections?.[name];
      if (p) return { def: p, uri: rec.uri };
    }
    return undefined;
  }

  /** Resolve an action by name. */
  resolveAction(name: string): { def: ActionDefinition; uri: string } | undefined {
    for (const rec of this.documents.values()) {
      const a = rec.result.document.actions?.[name];
      if (a) return { def: a, uri: rec.uri };
    }
    return undefined;
  }

  /** Resolve a query by name. */
  resolveQuery(name: string): { def: QueryDefinition; uri: string } | undefined {
    for (const rec of this.documents.values()) {
      const q = rec.result.document.queries?.[name];
      if (q) return { def: q, uri: rec.uri };
    }
    return undefined;
  }

  /** Resolve an entity/state by name. */
  resolveEntity(name: string): { def: EntityDefinition; uri: string } | undefined {
    for (const rec of this.documents.values()) {
      const e = rec.result.document.state?.[name];
      if (e) return { def: e, uri: rec.uri };
    }
    return undefined;
  }

  /** Resolve a relationship by name. */
  resolveRelationship(name: string): { def: RelationshipDefinition; uri: string } | undefined {
    for (const rec of this.documents.values()) {
      const r = rec.result.document.relationships?.[name];
      if (r) return { def: r, uri: rec.uri };
    }
    return undefined;
  }

  /** Resolve a commit envelope by name. */
  resolveCommitEnvelope(name: string): { def: CommitEnvelopeDefinition; uri: string } | undefined {
    for (const rec of this.documents.values()) {
      const ce = rec.result.document.commitEnvelopes?.[name];
      if (ce) return { def: ce, uri: rec.uri };
    }
    return undefined;
  }

  /** Return all unique prompt names across the workspace. */
  allPromptNames(): string[] {
    const names = new Set<string>();
    for (const rec of this.documents.values()) {
      const p = rec.result.document.prompts;
      if (p) Object.keys(p).forEach((n) => names.add(n));
    }
    return [...names].sort();
  }

  /** Return all unique decision names across the workspace. */
  allDecisionNames(): string[] {
    const names = new Set<string>();
    for (const rec of this.documents.values()) {
      const d = rec.result.document.decisions;
      if (d) Object.keys(d).forEach((n) => names.add(n));
    }
    return [...names].sort();
  }

  /** Return all unique memory names across the workspace. */
  allMemoryNames(): string[] {
    const names = new Set<string>();
    for (const rec of this.documents.values()) {
      const m = rec.result.document.memories;
      if (m) Object.keys(m).forEach((n) => names.add(n));
    }
    return [...names].sort();
  }

  /** Return all unique provider names across the workspace. */
  allProviderNames(): string[] {
    const names = new Set<string>();
    for (const rec of this.documents.values()) {
      const p = rec.result.document.providers;
      if (p) Object.keys(p).forEach((n) => names.add(n));
    }
    return [...names].sort();
  }

  resolvePrompt(name: string): { def: PromptDefinition; uri: string } | undefined {
    for (const rec of this.documents.values()) {
      const p = rec.result.document.prompts?.[name];
      if (p) return { def: p, uri: rec.uri };
    }
    return undefined;
  }

  resolveDecision(name: string): { def: DecisionDefinition; uri: string } | undefined {
    for (const rec of this.documents.values()) {
      const d = rec.result.document.decisions?.[name];
      if (d) return { def: d, uri: rec.uri };
    }
    return undefined;
  }

  resolveMemory(name: string): { def: MemoryDefinition; uri: string } | undefined {
    for (const rec of this.documents.values()) {
      const m = rec.result.document.memories?.[name];
      if (m) return { def: m, uri: rec.uri };
    }
    return undefined;
  }

  resolveProvider(name: string): { def: ProviderDefinition; uri: string } | undefined {
    for (const rec of this.documents.values()) {
      const p = rec.result.document.providers?.[name];
      if (p) return { def: p, uri: rec.uri };
    }
    return undefined;
  }

  /** Return all unique commit envelope names across the workspace. */
  allCommitEnvelopeNames(): string[] {
    const names = new Set<string>();
    for (const rec of this.documents.values()) {
      const ce = rec.result.document.commitEnvelopes;
      if (ce) Object.keys(ce).forEach((n) => names.add(n));
    }
    return [...names].sort();
  }

  /**
   * Find all references to a symbol by name.
   * "Reference" means any place the string appears as a value (event_type,
   * source_events, from:, emit, submit, relationship, etc.)
   */
  findReferences(name: string): Array<{ uri: string; range: Range }> {
    const refs: Array<{ uri: string; range: Range }> = [];
    for (const rec of this.documents.values()) {
      const doc = rec.result.document;
      const uri = rec.uri;

      // Search raw text for all occurrences (fast path for rename)
      const text = doc.text;
      const pattern = new RegExp(`\\b${escapeRegex(name)}\\b`, 'g');
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(text)) !== null) {
        const start = posFromOffset(text, m.index);
        const end = posFromOffset(text, m.index + name.length);
        refs.push({ uri, range: { start, end } });
      }
    }
    return refs;
  }

  /** Total number of indexed documents. */
  get size(): number {
    return this.documents.size;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function posFromOffset(text: string, offset: number): { line: number; character: number } {
  let line = 0;
  let lastNl = -1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') { line++; lastNl = i; }
  }
  return { line, character: offset - lastNl - 1 };
}
