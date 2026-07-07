/**
 * Causet completion provider.
 *
 * Context-aware completions for top-level sections, DSL keys, operation types,
 * event/action/projection names, types, and namespace expressions.
 */

import {
  CompletionItem,
  CompletionItemKind,
  Position,
  InsertTextFormat,
} from 'vscode-languageserver/node.js';
import type { CausetDocument } from 'causet-shared';
import { WorkspaceIndex } from 'causet-shared';

// ---------------------------------------------------------------------------
// Static token sets
// ---------------------------------------------------------------------------

const TOP_LEVEL_SECTIONS = [
  'dsl_version', 'app', 'includes', 'state', 'events', 'actions',
  'projections', 'queries', 'relationships', 'listeners', 'sagas', 'resources',
  'commit_envelopes', 'prompts', 'decisions', 'memories', 'providers',
];

const ALL_OPS = [
  'set', 'add', 'sub', 'unset', 'merge', 'push', 'remove', 'filter', 'find',
  'map', 'sort', 'clone', 'if', 'for_each', 'foreach', 'stop', 'continue',
  'emit', 'emit_each', 'submit', 'decision', 'reject', 'schedule', 'lock', 'unlock',
  'lookup', 'relationship_create', 'relationship_remove', 'compute_regen',
  'upsert', 'delete', 'replace', 'soft_delete', 'bulk_update', 'update', 'increment',
];

const AI_EXECUTORS = ['mock', 'openai', 'anthropic', 'ollama'];

const MUTATION_OPS = ['upsert', 'delete', 'replace', 'bulk_update'];
const RULE_OPS = ['set', 'add', 'sub', 'unset', 'merge', 'push', 'remove', 'filter',
  'find', 'map', 'sort', 'clone', 'emit', 'emit_each', 'submit', 'reject', 'schedule',
  'lock', 'unlock', 'lookup', 'relationship_create', 'relationship_remove', 'if', 'for_each'];

const SCALAR_TYPES = [
  'string', 'number', 'int', 'integer', 'decimal', 'boolean', 'bool',
  'array', 'object', 'any', 'json', 'timestamp', 'datetime', 'date', 'uuid',
  'float', 'double',
];

const SQL_TYPES = [
  'TEXT', 'INTEGER', 'INT', 'BIGINT', 'BOOLEAN', 'FLOAT', 'DOUBLE', 'JSON',
  'UUID', 'TIMESTAMP', 'DECIMAL', 'NUMERIC', 'SMALLINT', 'JSONB', 'BYTEA',
  'DOUBLE', 'TINYINT', 'CHAR', 'VARCHAR', 'REAL',
];

const NAMESPACES = [
  'event', 'entity', 'intent', 'input', 'state', 'projection', 'aggregate',
  'global', 'platform', 'it', 'item', 'resources', 'derived', 'envelope',
];

const PARTITION_STRATEGIES = ['range', 'hash', 'list'];
const CAUSAL_MODES = ['per_entity', 'per_aggregate', 'global'];
const VISIBILITY_STRATEGIES = ['shadow_state', 'immediate'];
const AGGREGATE_FNS = ['sum', 'count', 'avg', 'min', 'max', 'first', 'last'];

const BUILTIN_FUNCTIONS = [
  'max', 'min', 'floor', 'size', 'sum', 'contains', 'map', 'concat',
  'join', 'shard', 'coalesce', 'isnull', 'format_date', 'is_prev_day',
  'hash', 'LOOKUP_FIELD', 'lookup',
];

const QUERY_OPERATORS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'gte_window', 'like', 'ilike'];
const SORT_DIRECTIONS = ['asc', 'desc'];
const JOIN_TYPES = ['left', 'right', 'inner', 'cross'];
const CARDINALITIES = ['many_to_many', 'one_to_many', 'one_to_one'];
const EVENT_KINDS = ['event', 'system', 'fact', 'compute', 'command'];
const RULE_PHASES = ['preflight', 'core', 'side_effects'];

// ---------------------------------------------------------------------------
// Context detection
// ---------------------------------------------------------------------------

interface CompletionContext {
  linePrefix: string;
  indentLevel: number;
  afterOp: boolean;
  afterType: boolean;
  afterEventType: boolean;
  afterIntentType: boolean;
  afterFrom: boolean;
  afterTable: boolean;
  afterRelationship: boolean;
  afterState: boolean;
  afterTargetStream: boolean;
  afterQueryOp: boolean;
  afterOrderBy: boolean;
  afterJoinType: boolean;
  afterCardinality: boolean;
  afterKind: boolean;
  afterRef: boolean;
  afterPrompt: boolean;
  afterProvider: boolean;
  afterEmits: boolean;
  afterNamespace: string | null;
  inSourceEvents: boolean;
  inPrimaryKey: boolean;
  inColumns: boolean;
  inExpr: boolean;
}

function detectContext(text: string, position: Position): CompletionContext {
  const lines = text.split('\n');
  const linePrefix = lines[position.line]?.slice(0, position.character) ?? '';
  const indentLevel = linePrefix.search(/\S/);

  return {
    linePrefix,
    indentLevel,
    afterOp: /\bop:\s*$/.test(linePrefix) || /\bop:\s+\w*$/.test(linePrefix),
    afterType: /\b(type|item_type):\s*\w*$/.test(linePrefix),
    afterEventType: /\bevent_type:\s*\w*$/.test(linePrefix),
    afterIntentType: /\bintent_type:\s*\w*$/.test(linePrefix),
    afterFrom: /\bfrom:\s*\w*$/.test(linePrefix),
    afterTable: /\btable:\s*\w*$/.test(linePrefix),
    afterRelationship: /\brelationship:\s*\w*$/.test(linePrefix),
    afterState: /(?<!\w)(state):\s*\w*$/.test(linePrefix),
    afterTargetStream: /\btarget_stream:\s*\w*$/.test(linePrefix),
    afterQueryOp: /\b(eq|neq|gt|gte|lt|lte|in|nin|gte_window|like|ilike):\s*$/.test(linePrefix),
    afterOrderBy: /(?:desc|asc)?\s*$/.test(linePrefix) && lines[position.line - 1]?.includes('order_by'),
    afterJoinType: /\btype:\s*\w*$/.test(linePrefix),
    afterCardinality: /\bcardinality:\s*\w*$/.test(linePrefix),
    afterKind: /\bkind:\s*\w*$/.test(linePrefix),
    afterRef: /\bref:\s*\w*$/.test(linePrefix),
    afterPrompt: /\bprompt:\s*\w*$/.test(linePrefix),
    afterProvider: /\bprovider:\s*\w*$/.test(linePrefix),
    afterEmits: /\bemits:\s*\w*$/.test(linePrefix),
    afterNamespace: extractNamespace(linePrefix),
    inSourceEvents: lines.slice(0, position.line).some((l) => /^\s*source_events\s*:/.test(l)) &&
      !lines.slice(0, position.line).some((l, i) => i > lines.slice(0, position.line).findIndex((ll) => /source_events/.test(ll)) && /^\S/.test(l)),
    inPrimaryKey: /primary_key/.test(lines[position.line - 1] ?? '') || /primary_key/.test(lines[position.line - 2] ?? ''),
    inColumns: /columns/.test(lines[position.line - 1] ?? '') || /columns/.test(lines[position.line - 2] ?? ''),
    inExpr: /(?:expr|where|value|entity_expr|entity_id_expr):\s*["']?[^"']*$/.test(linePrefix),
  };
}

function extractNamespace(linePrefix: string): string | null {
  const m = linePrefix.match(/\b(event|entity|intent|input|state|projection|aggregate|global|platform|it|item|resources|derived|envelope)\.(\w*)$/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Completion item helpers
// ---------------------------------------------------------------------------

function kw(label: string, detail?: string, sortText?: string): CompletionItem {
  return { label, kind: CompletionItemKind.Keyword, detail, sortText };
}

function prop(label: string, detail?: string, insertText?: string): CompletionItem {
  return {
    label,
    kind: CompletionItemKind.Property,
    detail,
    insertText,
    insertTextFormat: insertText?.includes('$') ? InsertTextFormat.Snippet : InsertTextFormat.PlainText,
  };
}

function opItem(label: string, detail?: string): CompletionItem {
  return { label, kind: CompletionItemKind.Operator, detail };
}

function typeItem(label: string): CompletionItem {
  return { label, kind: CompletionItemKind.TypeParameter };
}

function refItem(label: string, kind: CompletionItemKind, detail?: string): CompletionItem {
  return { label, kind, detail };
}

function snippet(label: string, insertText: string, detail?: string): CompletionItem {
  return {
    label,
    kind: CompletionItemKind.Snippet,
    insertText,
    insertTextFormat: InsertTextFormat.Snippet,
    detail,
  };
}

// ---------------------------------------------------------------------------
// Namespace member completions
// ---------------------------------------------------------------------------

function getNamespaceMembers(ns: string, doc: CausetDocument, index: WorkspaceIndex): CompletionItem[] {
  const items: CompletionItem[] = [];

  if (ns === 'event') {
    // Reserved
    for (const r of ['ts', 'entity_id', 'type']) {
      items.push(refItem(r, CompletionItemKind.Variable, 'Reserved event field'));
    }
    // All event payload fields across workspace
    for (const d of index.allDocuments()) {
      for (const ev of Object.values(d.events ?? {})) {
        for (const f of Object.keys(ev.payload ?? {})) {
          items.push(refItem(f, CompletionItemKind.Field, `From event: ${ev.name}`));
        }
      }
    }
  }

  if (ns === 'entity' || ns === 'state') {
    for (const d of index.allDocuments()) {
      for (const ent of Object.values(d.state ?? {})) {
        for (const f of ent.fields) {
          items.push(refItem(f.name, CompletionItemKind.Field, `entity: ${ent.name}`));
        }
      }
    }
  }

  if (ns === 'input' || ns === 'intent') {
    for (const d of index.allDocuments()) {
      for (const act of Object.values(d.actions ?? {})) {
        for (const f of Object.keys(act.input ?? {})) {
          items.push(refItem(f, CompletionItemKind.Field, `From action: ${act.name}`));
        }
      }
    }
  }

  if (ns === 'resources') {
    for (const d of index.allDocuments()) {
      for (const r of Object.keys(d.resources ?? {})) {
        items.push(refItem(r, CompletionItemKind.Value, 'Resource table'));
      }
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Main completion provider
// ---------------------------------------------------------------------------

export function provideCompletions(
  doc: CausetDocument,
  position: Position,
  text: string,
  index: WorkspaceIndex,
): CompletionItem[] {
  const ctx = detectContext(text, position);
  const items: CompletionItem[] = [];

  // ---- Namespace member completion (event., entity., etc.) ----
  if (ctx.afterNamespace) {
    return getNamespaceMembers(ctx.afterNamespace, doc, index);
  }

  // ---- op: completions ----
  if (ctx.afterOp) {
    for (const op of ALL_OPS) {
      items.push(opItem(op, `Causet op: ${op}`));
    }
    return items;
  }

  // ---- type: / item_type: completions ----
  if (ctx.afterType) {
    for (const t of SCALAR_TYPES) items.push(typeItem(t));
    return items;
  }

  // ---- ref: (decision op) ----
  if (ctx.afterRef) {
    for (const name of index.allDecisionNames()) {
      items.push(refItem(name, CompletionItemKind.Function, 'Decision'));
    }
    for (const name of Object.keys(doc.decisions ?? {})) {
      if (!index.allDecisionNames().includes(name)) {
        items.push(refItem(name, CompletionItemKind.Function, 'Decision (local)'));
      }
    }
    return items;
  }

  // ---- prompt: (decision references prompt template) ----
  if (ctx.afterPrompt) {
    for (const name of index.allPromptNames()) {
      items.push(refItem(name, CompletionItemKind.Text, 'Prompt template'));
    }
    return items;
  }

  // ---- provider: (decision or memory embedding) ----
  if (ctx.afterProvider) {
    for (const name of index.allProviderNames()) {
      items.push(refItem(name, CompletionItemKind.Interface, 'AI provider'));
    }
    return items;
  }

  // ---- emits: (decision output event) ----
  if (ctx.afterEmits) {
    for (const name of index.allEventNames()) {
      items.push(refItem(name, CompletionItemKind.Event, 'Event'));
    }
    return items;
  }

  // ---- executor: (provider legacy / direct) ----
  if (/\bexecutor:\s*\w*$/.test(ctx.linePrefix)) {
    return AI_EXECUTORS.map((e) => refItem(e, CompletionItemKind.EnumMember, 'AI executor'));
  }

  // ---- event_type: completions ----
  if (ctx.afterEventType) {
    for (const name of index.allEventNames()) {
      items.push(refItem(name, CompletionItemKind.Event, 'Event'));
    }
    for (const name of Object.keys(doc.events ?? {})) {
      if (!index.allEventNames().includes(name)) {
        items.push(refItem(name, CompletionItemKind.Event, 'Event (local)'));
      }
    }
    return items;
  }

  // ---- intent_type: completions ----
  if (ctx.afterIntentType) {
    for (const name of index.allActionNames()) {
      items.push(refItem(name, CompletionItemKind.Method, 'Action'));
    }
    return items;
  }

  // ---- from: completions (projection names) ----
  if (ctx.afterFrom) {
    for (const name of index.allProjectionNames()) {
      items.push(refItem(name, CompletionItemKind.Class, 'Projection'));
    }
    for (const name of Object.keys(doc.projections ?? {})) {
      if (!index.allProjectionNames().includes(name)) {
        items.push(refItem(name, CompletionItemKind.Class, 'Projection (local)'));
      }
    }
    return items;
  }

  // ---- table: completions (projection table names) ----
  if (ctx.afterTable) {
    for (const proj of Object.values(doc.projections ?? {})) {
      if (proj.target.table) items.push(refItem(proj.target.table, CompletionItemKind.Class, 'Table'));
    }
    return items;
  }

  // ---- state: (entity name references) ----
  if (ctx.afterState) {
    for (const name of index.allEntityNames()) {
      items.push(refItem(name, CompletionItemKind.Struct, 'Entity'));
    }
    return items;
  }

  // ---- target_stream: ----
  if (ctx.afterTargetStream) {
    for (const name of index.allEntityNames()) {
      items.push(refItem(name, CompletionItemKind.Struct, 'Entity stream'));
    }
    return items;
  }

  // ---- cardinality: ----
  if (ctx.afterCardinality) {
    return CARDINALITIES.map((c) => refItem(c, CompletionItemKind.EnumMember, 'Cardinality'));
  }

  // ---- kind: ----
  if (ctx.afterKind) {
    return EVENT_KINDS.map((k) => refItem(k, CompletionItemKind.EnumMember, 'Event kind'));
  }

  // ---- join type: ----
  if (ctx.afterJoinType) {
    return JOIN_TYPES.map((t) => refItem(t, CompletionItemKind.EnumMember, 'Join type'));
  }

  // ---- partition strategy: ----
  if (/\bstrategy:\s*\w*$/.test(ctx.linePrefix)) {
    // Inside visibility_gate: shadow_state | immediate
    if (ctx.linePrefix.includes('visibility')) {
      return VISIBILITY_STRATEGIES.map((s) => refItem(s, CompletionItemKind.EnumMember, 'Visibility strategy'));
    }
    // Inside partition: range | hash | list
    return PARTITION_STRATEGIES.map((s) => refItem(s, CompletionItemKind.EnumMember, 'Partition strategy'));
  }

  // ---- causal_ordering mode: ----
  if (/\bmode:\s*\w*$/.test(ctx.linePrefix)) {
    return CAUSAL_MODES.map((m) => refItem(m, CompletionItemKind.EnumMember, 'Causal ordering mode'));
  }

  // ---- aggregate functions (sum:, count:, avg:) ----
  if (/^\s+aggregate\s*:/.test(ctx.linePrefix) || (ctx.indentLevel >= 8 && !/op:/.test(ctx.linePrefix))) {
    return AGGREGATE_FNS.map((fn) => prop(fn + ':', `Aggregate function: ${fn}`));
  }

  // ---- start_action / lifecycle events — action/event references ----
  if (/\b(start_action|prepare_event|prepared_event|commit_event|abort_event|tick_event):\s*\w*$/.test(ctx.linePrefix)) {
    // If it looks like an event, offer events; if action, offer actions
    if (/start_action:/.test(ctx.linePrefix)) {
      return index.allActionNames().map((n) => refItem(n, CompletionItemKind.Method, 'Action'));
    }
    if (/tick_event:/.test(ctx.linePrefix)) {
      return index.allEventNames().filter((n) => n.toUpperCase() === n)
        .map((n) => refItem(n, CompletionItemKind.Event, 'System event'));
    }
    return index.allEventNames().map((n) => refItem(n, CompletionItemKind.Event, 'Event'));
  }

  // ---- source_events list ----
  if (ctx.inSourceEvents) {
    const linePrefix = ctx.linePrefix.trimStart();
    if (linePrefix.startsWith('-') || linePrefix === '' ) {
      for (const name of index.allEventNames()) {
        items.push(refItem(name, CompletionItemKind.Event, 'Event'));
      }
      return items;
    }
  }

  // ---- Expression context: namespaces and builtins ----
  if (ctx.inExpr) {
    for (const ns of NAMESPACES) {
      items.push(refItem(ns, CompletionItemKind.Variable, 'Namespace'));
    }
    for (const fn of BUILTIN_FUNCTIONS) {
      items.push(refItem(fn + '(', CompletionItemKind.Function, 'Builtin function'));
    }
    return items;
  }

  // ---- Generic: top-level sections + all DSL keys + snippets ----

  // Top-level section keywords
  for (const s of TOP_LEVEL_SECTIONS) {
    items.push(kw(s + ':', `Causet section: ${s}`, '0_' + s));
  }

  // DSL property keys
  const dslKeys = [
    'entity_key', 'entity_expr', 'entity_id_expr', 'payload', 'target',
    'primary_key', 'derive', 'mutations', 'aggregates', 'aggregate', 'indexes',
    'fields', 'rules', 'then', 'core', 'side_effects', 'source_events', 'table',
    'input', 'required', 'description', 'default', 'type', 'item_type', 'item_fields',
    'op', 'path', 'value', 'event_type', 'intent_type', 'target_stream', 'target_entity',
    'override', 'on', 'when', 'expr', 'from', 'where', 'order_by', 'group_by',
    'joins', 'left', 'right', 'eq', 'neq', 'gte', 'lte', 'gt', 'lt', 'in', 'nin',
    'gte_window', 'like', 'ilike', 'limit', 'direction', 'distinct', 'count', 'sum',
    'coalesce_zero', 'preflight', 'message', 'code', 'name', 'priority', 'mutate',
    'field', 'by', 'floor', 'bucket', 'interval', 'window', 'allowed', 'unique',
    'cardinality', 'emit_events', 'created', 'removed', 'kind', 'cap', 'max', 'min',
    'delay_seconds', 'relationship', 'to_id', 'from_id', 'into', 'as', 'state_path',
    'steps', 'end', 'pairs', 'columns', 'lock_key', 'partition', 'key',
    'shard_id', 'metadata_json', 'status', 'source', 'coalesce',
    // AI decisions / memory
    'prompts', 'decisions', 'memories', 'providers', 'prompt', 'provider', 'executor',
    'model', 'instructions', 'emits', 'output', 'embedding', 'partition_by', 'content',
    'temperature', 'max_tokens', 'timeout', 'retries', 'ref', 'memories',
    // commit_envelopes keys
    'start_action', 'envelope_state', 'envelope_state_path', 'lifecycle', 'timeout',
    'causal_ordering', 'participants', 'prepare_event', 'prepared_event', 'commit_event',
    'abort_event', 'abort_after_seconds', 'tick_event', 'mode', 'cursor_field', 'seq_source',
    'delta_expr', 'visibility_gate', 'strategy', 'visible_path', 'pending_path',
    // partition keys
    'precreate', 'retention', 'default_partition', 'partitions',
    // query aggregate fns
    'avg', 'first', 'last',
    // misc
    'for_each', 'stream',
  ];
  for (const k of dslKeys) {
    items.push(prop(k + ':', `DSL property: ${k}`, undefined));
  }

  // Rule phase keywords
  for (const p of RULE_PHASES) {
    items.push(kw(p + ':', 'Rule phase', '1_' + p));
  }

  // SQL types (for fields blocks)
  for (const t of SQL_TYPES) {
    items.push(typeItem(t));
  }

  // Scalar types
  for (const t of SCALAR_TYPES) {
    items.push(typeItem(t));
  }

  // Namespace prefixes
  for (const ns of NAMESPACES) {
    items.push(refItem(ns, CompletionItemKind.Variable, 'Namespace'));
  }

  // Builtin functions
  for (const fn of BUILTIN_FUNCTIONS) {
    items.push(refItem(fn, CompletionItemKind.Function, 'Builtin function'));
  }

  // Workspace symbols as references
  for (const name of index.allEventNames()) {
    items.push(refItem(name, CompletionItemKind.Event, 'Event'));
  }
  for (const name of index.allProjectionNames()) {
    items.push(refItem(name, CompletionItemKind.Class, 'Projection'));
  }
  for (const name of index.allActionNames()) {
    items.push(refItem(name, CompletionItemKind.Method, 'Action'));
  }
  for (const name of index.allEntityNames()) {
    items.push(refItem(name, CompletionItemKind.Struct, 'Entity'));
  }
  for (const name of index.allQueryNames()) {
    items.push(refItem(name, CompletionItemKind.Function, 'Query'));
  }
  for (const name of index.allRelationshipNames()) {
    items.push(refItem(name, CompletionItemKind.Interface, 'Relationship'));
  }
  for (const name of index.allPromptNames()) {
    items.push(refItem(name, CompletionItemKind.Text, 'Prompt'));
  }
  for (const name of index.allDecisionNames()) {
    items.push(refItem(name, CompletionItemKind.Function, 'Decision'));
  }
  for (const name of index.allMemoryNames()) {
    items.push(refItem(name, CompletionItemKind.Struct, 'Memory'));
  }
  for (const name of index.allProviderNames()) {
    items.push(refItem(name, CompletionItemKind.Interface, 'Provider'));
  }

  return items;
}
