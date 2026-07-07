/**
 * CodeLens provider.
 *
 * Shows inline contextual information above projections, events, and actions:
 *   - Projections: consumed events count, output table, indexes, PK
 *   - Events: consumed by N projections, produced by N actions
 *   - Actions: emits N events
 */

import { CodeLens, Range as LspRange } from 'vscode-languageserver/node.js';
import type { CausetDocument, Range } from 'causet-shared';
import { WorkspaceIndex } from 'causet-shared';

function toRange(r: Range): LspRange {
  return {
    start: { line: r.start.line, character: r.start.character },
    end: { line: r.end.line, character: r.end.character },
  };
}

export function provideCodeLens(doc: CausetDocument, index: WorkspaceIndex): CodeLens[] {
  const lenses: CodeLens[] = [];

  // ---------------------------------------------------------------------------
  // Projection lenses
  // ---------------------------------------------------------------------------
  for (const [name, proj] of Object.entries(doc.projections ?? {})) {
    const r = toRange(proj.range);

    // Source events count
    if (proj.sourceEvents.length > 0) {
      lenses.push({
        range: r,
        command: {
          title: `⚡ ${proj.sourceEvents.length} source event${proj.sourceEvents.length > 1 ? 's' : ''}: ${proj.sourceEvents.join(', ')}`,
          command: '',
        },
      });
    }

    // Output table
    if (proj.target.table) {
      lenses.push({
        range: r,
        command: {
          title: `🗄 table: ${proj.target.table}`,
          command: '',
        },
      });
    }

    // Primary key
    if (proj.target.primaryKey?.length) {
      lenses.push({
        range: r,
        command: {
          title: `🔑 pk: [${proj.target.primaryKey.join(', ')}]`,
          command: '',
        },
      });
    }

    // Indexes
    if (proj.indexes && proj.indexes.length > 0) {
      const idxLabel = proj.indexes.map((i) => `[${i.columns.join(', ')}]`).join(', ');
      lenses.push({
        range: r,
        command: {
          title: `📇 ${proj.indexes.length} index${proj.indexes.length > 1 ? 'es' : ''}: ${idxLabel}`,
          command: '',
        },
      });
    }

    // Queries reading this projection
    const readingQueries = index.allDocuments()
      .flatMap((d) => Object.entries(d.queries ?? {}))
      .filter(([, q]) => q.from === name || Object.keys(q.joins ?? {}).includes(name))
      .map(([n]) => n);
    if (readingQueries.length > 0) {
      lenses.push({
        range: r,
        command: {
          title: `🔍 read by ${readingQueries.length} quer${readingQueries.length > 1 ? 'ies' : 'y'}: ${readingQueries.slice(0, 3).join(', ')}${readingQueries.length > 3 ? '…' : ''}`,
          command: '',
        },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Event lenses
  // ---------------------------------------------------------------------------
  for (const [name, ev] of Object.entries(doc.events ?? {})) {
    const r = toRange(ev.range);

    // Consumed by projections
    const consumers = index.allDocuments()
      .flatMap((d) => Object.entries(d.projections ?? {}))
      .filter(([, p]) => p.sourceEvents.includes(name))
      .map(([n]) => n);
    if (consumers.length > 0) {
      lenses.push({
        range: r,
        command: {
          title: `📊 consumed by ${consumers.length} projection${consumers.length > 1 ? 's' : ''}: ${consumers.slice(0, 3).join(', ')}${consumers.length > 3 ? '…' : ''}`,
          command: '',
        },
      });
    }

    // Produced by actions (emit event_type references)
    const producers = index.allDocuments()
      .flatMap((d) => Object.entries(d.actions ?? {}))
      .filter(([, act]) => {
        const phases = [act.preflight, act.core, act.sideEffects];
        return phases.some((p) =>
          p?.rules.some((r) =>
            r.then.some((op) => op.op === 'emit' && op.eventType === name)
          )
        );
      })
      .map(([n]) => n);
    if (producers.length > 0) {
      lenses.push({
        range: r,
        command: {
          title: `⚙ produced by ${producers.length} action${producers.length > 1 ? 's' : ''}: ${producers.slice(0, 3).join(', ')}${producers.length > 3 ? '…' : ''}`,
          command: '',
        },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Action lenses
  // ---------------------------------------------------------------------------
  for (const [name, act] of Object.entries(doc.actions ?? {})) {
    const r = toRange(act.range);

    // Collect emitted events from all phases
    const emitted = new Set<string>();
    const phases = [act.preflight, act.core, act.sideEffects];
    for (const phase of phases) {
      for (const rule of (phase?.rules ?? [])) {
        for (const op of rule.then) {
          if ((op.op === 'emit' || op.op === 'emit_each') && op.eventType) {
            emitted.add(op.eventType);
          }
        }
      }
    }
    if (emitted.size > 0) {
      lenses.push({
        range: r,
        command: {
          title: `📤 emits: ${[...emitted].join(', ')}`,
          command: '',
        },
      });
    }

    // Input fields count
    const inputCount = Object.keys(act.input ?? {}).length;
    if (inputCount > 0) {
      lenses.push({
        range: r,
        command: {
          title: `📥 ${inputCount} input field${inputCount > 1 ? 's' : ''}`,
          command: '',
        },
      });
    }
  }

  return lenses;
}
