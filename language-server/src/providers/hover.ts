/**
 * Causet hover provider.
 *
 * Hovering a symbol shows structured documentation about what it is,
 * its definition, and cross-references in the workspace.
 */

import { Hover, MarkupContent, MarkupKind, Position } from 'vscode-languageserver/node.js';
import type { CausetDocument } from 'causet-shared';
import { WorkspaceIndex } from 'causet-shared';

// ---------------------------------------------------------------------------
// Word at position helper
// ---------------------------------------------------------------------------

function wordAtPosition(text: string, position: Position): { word: string; start: number; end: number } | null {
  const lines = text.split('\n');
  const line = lines[position.line] ?? '';
  const ch = position.character;

  let start = ch;
  let end = ch;
  while (start > 0 && /[A-Za-z0-9_]/.test(line[start - 1])) start--;
  while (end < line.length && /[A-Za-z0-9_]/.test(line[end])) end++;
  const word = line.slice(start, end);
  return word ? { word, start, end } : null;
}

// ---------------------------------------------------------------------------
// Documentation registry
// ---------------------------------------------------------------------------

const DSL_KEY_DOCS: Record<string, string> = {
  state: '**state** — Entity schema definition.\n\nDefines write-side aggregates (streams). Each named key becomes a stream. Owns `entity_key`, `description`, and `fields`.',
  events: '**events** — Domain event registry.\n\nImmutable facts emitted to the ledger. Every `emit` in an action must reference an event declared here.',
  actions: '**actions** — Business intent (command) handlers.\n\nProcessed synchronously by the runtime: `preflight` → `core` → `side_effects`. State mutations happen in `core`.',
  projections: '**projections** — Materialized read models.\n\nEvent-driven UPSERTs into Postgres tables. Source events are consumed from Kafka asynchronously.',
  queries: '**queries** — Named parameterized SQL queries.\n\nCompile to IR and execute against projection tables. No arbitrary SQL in application code.',
  relationships: '**relationships** — Graph edge definitions.\n\nModels (from, to) pairs with optional lifecycle events.',
  listeners: '**listeners** — Deterministic same-envelope reactions.\n\nFire after events in the same commit envelope. No I/O, no cross-service calls.',
  sagas: '**sagas** — Multi-step state machine coordination.\n\nEach step transitions on an event type.',
  resources: '**resources** — Static lookup tables.\n\nAccessed via `resources.name[key].field` in expressions.',
  entity_key: '**entity_key** — The partition key for this entity stream.\n\nMust match the field name used as the stream routing key.',
  entity_expr: '**entity_expr** — Expression resolving the stream entity ID for an event.\n\nTypically `event.entity_id` or `event.<id_field>`.',
  entity_id_expr: '**entity_id_expr** — Expression resolving the stream entity ID for an action.\n\nTypically `event.<id_field>` or `input.<id_field>`.',
  source_events: '**source_events** — Events this projection consumes.\n\nAll entries must be registered in `events:`. The projection worker subscribes via Kafka.',
  primary_key: '**primary_key** — Columns forming the UPSERT key for this projection table.\n\nEvery PK column must appear in `derive:`.',
  derive: '**derive** — Expressions mapping event payload fields to projection columns.\n\nAllowed references: `event.payload.*`, `event.ts`, `event.entity_id`, `event.type`, `state.*`, `lookup(...)`, `shard(...)`.',
  mutations: '**mutations** — Per-event write operations for this projection.\n\nKeys are event names. Values are `{ op: upsert|delete|replace }`.',
  aggregates: '**aggregates** — Increment/decrement operations per event.\n\nKeys are event names. Values are field → `{ op: add|sub|set, by: N }`.',
  indexes: '**indexes** — PostgreSQL indexes on this projection table.\n\nAdd indexes for every column used in `where:` or `order_by:` clauses.',
  preflight: '**preflight** — Validation rules that run before state mutation.\n\n`op: reject` aborts the intent. Mutations are not allowed.',
  core: '**core** — Transactional state mutation phase.\n\nRuns synchronously. Rolls back on failure. Only own-stream mutations are allowed.',
  side_effects: '**side_effects** — Non-transactional follow-up phase.\n\nEmits, submits, and schedules. Does NOT roll back if core succeeds.',
  payload: '**payload** — Immutable data carried by an event.\n\nFields map to `event.<field>` in expressions. Never use `type`, `ts`, or `entity_id` as field names — they shadow envelope fields.',
  input: '**input** — Action intent payload schema.\n\nTyped with `type:` and `required:` per field.',
  when: '**when** — Rule condition.\n\nUse `{ expr: "..." }` for conditional rules, or `{}` (empty) for unconditional rules.',
  then: '**then** — Rule operations list.\n\nOrdered list of `op:` instructions to execute when `when` matches.',
  op: '**op** — Causet runtime instruction.\n\nSee the operations directory for the full list.',
  set: '**op: set** — Set a field to a value.\n\n`path:` uses slash notation (`/status`). `value:` is an expression.',
  emit: '**op: emit** — Emit a domain event into the ledger.\n\n`event_type:` must be registered under `events:`. Include all payload fields.',
  submit: '**op: submit** — Submit a follow-up intent to another action.\n\nUsed in `side_effects`. Targets another entity stream.',
  reject: '**op: reject** — Abort the intent with an error code.\n\n**Preflight only.** Returns the `code:` as the error response.',
  upsert: '**op: upsert** — Insert or update a projection row on conflict.\n\nDefault projection mutation operation.',
  delete: '**op: delete** — Remove a projection row matching the primary key.',
  add: '**op: add** — Add a value to a numeric field.\n\nUse `cap: { max: N }` to clamp. Use `isnull`/`coalesce` for nullable fields.',
  sub: '**op: sub** — Subtract a value from a numeric field.\n\nUse `cap: { min: 0 }` to floor at zero.',
  filter: '**op: filter** — Keep array elements matching a predicate.\n\n`where:` is a **plain string** expression using `it` as the iterator.',
  push: '**op: push** — Append an element to an array field.',
  remove: '**op: remove** — Remove array elements matching a predicate.\n\n`where:` is a **plain string** using `it` as the iterator.',
  find: '**op: find** — Find an array element and bind it to a variable.\n\n`where:` is a **plain string** using `it`. Bind result with `as:`.',
  lookup: '**op: lookup** — Read a snapshot from another stream into a variable (`into:`).',
  relationship_create: '**op: relationship_create** — Create a graph edge.\n\nAllowed in `core`. Optionally emits `emit_events.created` event.',
  relationship_remove: '**op: relationship_remove** — Remove a graph edge.\n\nAllowed in `core`. Optionally emits `emit_events.removed` event.',
  cardinality: '**cardinality** — Relationship multiplicity.\n\n`many_to_many` | `one_to_many` | `one_to_one`.',
  unique: '**unique** — Deduplicate edges at the engine level.\n\nPair with a preflight `reject` to surface semantic errors to callers.',
  emit_events: '**emit_events** — Lifecycle domain events for a relationship.\n\n`created:` fires on `relationship_create`. `removed:` fires on `relationship_remove`.',
  from: '**from** (query) — The primary projection this query reads from.',
  where: '**where** (query) — Filter conditions.\n\nOne operator per field. Operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`, `gte_window`, `like`, `ilike`.',
  order_by: '**order_by** — Sort order for query results.\n\nField → `asc` | `desc`.',
  group_by: '**group_by** — Grouping key for aggregate queries.\n\nRequires `aggregate:` block. Use a single scalar key for count queries.',
  aggregate: '**aggregate** — Aggregate functions for grouped queries.\n\nUse `count: field_name` for counts.',
  limit: '**limit** — Maximum number of rows returned.\n\nAdd a static limit on all hot paths.',
  joins: '**joins** — Projection joins for this query.\n\nMax 5 joins. Index all join keys.',
  coalesce_zero: '**coalesce_zero** — Replace NULL with 0 in the result row for these columns.',
  window: '**window** — Time-window configuration.\n\n`allowed:` lists valid window sizes (e.g. `["1h", "24h"]`). Used with `gte_window` operator.',
  fields: '**fields** (projection) — Explicit SQL column type declarations.\n\nAlways declare `fields:` to avoid type inference bugs (boolean columns default to TEXT without it).',
  description: '**description** — Human-readable documentation for this entity or field.',
  required: '**required** — Marks this input/field as mandatory.',
  default: '**default** — Default value for this field when not set.\n\nAlways declare defaults for array/object fields — omitting them yields `null`.',
  type: '**type** — DSL type for this field or input.\n\nValid: `string` `number` `int` `integer` `decimal` `boolean` `bool` `array` `object` `any` `json` `timestamp` `datetime` `date` `uuid` `float` `double`.',
  item_type: '**item_type** — Element type for array fields.',
  item_fields: '**item_fields** — Schema for object elements inside an array.',
  priority: '**priority** — Execution order within a rule phase (lower = earlier).',
  name: '**name** (rule) — Identifier for this rule. Used in error messages and debug tooling.',
  mutate: '**mutate** — Operations in a listener rule.\n\nTypically `op: increment` to accumulate totals.',
  bucket: '**bucket** — Time-window bucketing for projections.\n\n`field:` is the timestamp field. `interval:` is the bucket size (e.g. `24h`).',
  interval: '**interval** — Bucket interval size.\n\nValid values: `5m`, `1h`, `24h`, `1d`.',
  shard_id: '**shard_id** — Hot-counter sharding field.\n\nGenerate with `shard(expr, N)` in `derive:`. Include in `primary_key` to distribute write load.',
  target_stream: '**target_stream** — Target entity stream for cross-stream ops.',
  target_entity: '**target_entity** — Target entity key expression for cross-stream ops.',
  code: '**code** (reject) — Stable error code returned to the caller.\n\nUse SCREAMING_SNAKE_CASE. Never change deployed codes — clients depend on them.',
  message: '**message** — Human-readable error message for `op: reject`.',
  override: '**override** — Projection override block for special-case field handling.',
  table: '**table** — PostgreSQL table name for this projection.',
  target: '**target** — Projection output target configuration.',

  // ---- commit_envelopes section ----
  commit_envelopes: '**commit_envelopes** — 2-phase commit (2PC) envelope definitions.\n\nCoordinates distributed transactions across multiple entity streams via prepare → commit/abort lifecycle.',
  start_action: '**start_action** — The action that initiates this commit envelope.\n\nThe runtime enters prepare state when this action is processed.',
  envelope_state: '**envelope_state** — The entity stream used as the coordinator state machine.',
  envelope_state_path: '**envelope_state_path** — Path within the coordinator entity to store envelope state.',
  lifecycle: '**lifecycle** — Declares the four protocol events for this envelope.',
  prepare_event: '**prepare_event** — Event emitted by each participant to signal readiness.\n\nMust be declared under `events:`.',
  prepared_event: '**prepared_event** — Event emitted by the coordinator after all participants have prepared.',
  commit_event: '**commit_event** — Event emitted to finalize the transaction.',
  abort_event: '**abort_event** — Event emitted to roll back the transaction.',
  timeout: '**timeout** — Duration limit.\n\nCommit envelope: abort window config. AI provider/decision: LLM call timeout (e.g. `30s`).',
  abort_after_seconds: '**abort_after_seconds** — Seconds before an unprepared envelope is automatically aborted.',
  tick_event: '**tick_event** — A `kind: system` clock event that drives timeout evaluation.',
  causal_ordering: '**causal_ordering** — Enforces causal consistency across participant streams.\n\nEnsures participants apply the commit envelope in the correct order.',
  mode: '**mode** — Causal ordering mode.\n\n`per_entity`: order per entity ID. `per_aggregate`: order per aggregate. `global`: total order.',
  cursor_field: '**cursor_field** — Path on the participant entity storing the last-seen sequence number.',
  seq_source: '**seq_source** — Expression resolving the sequence number from the envelope payload.',
  participants: '**participants** — Entity streams participating in this commit envelope.\n\nEach participant applies a delta and gates visibility via `visibility_gate`.',
  delta_expr: '**delta_expr** — Expression computing the signed balance delta for this participant.\n\nUse negative values for debit: `0 - event.amount`.',
  visibility_gate: '**visibility_gate** — Controls when a participant\'s changes become visible.\n\n`shadow_state` strategy keeps changes in a pending buffer until the envelope commits.',
  strategy: '**strategy** — Visibility gate strategy.\n\n`shadow_state`: changes are held in `pending_path` until commit. `immediate`: changes are visible immediately.',
  visible_path: '**visible_path** — Path within the entity holding the committed (visible) state.',
  pending_path: '**pending_path** — Path within the entity holding pending envelope entries.',

  // ---- projection partition section ----
  partition: '**partition** — PostgreSQL declarative table partitioning.\n\nStrategies: `range` (date ranges), `hash` (write spread), `list` (categorical).',
  precreate: '**precreate** — Number of future partitions to pre-create at deploy time.\n\nApplies to `range` partitions.',
  retention: '**retention** — How long to retain range partitions before automatic pruning.\n\nFormat: `"N months"` or `"N years"`.',
  default_partition: '**default_partition** — Whether to create a DEFAULT partition that catches unmatched rows.',
  partitions: '**partitions** — Number of hash buckets for `hash` partition strategy.',

  // ---- AI decisions / memory ----
  providers: '**providers** — Logical AI provider definitions.\n\nBind executor + model without credentials. Referenced by `decisions:` and `memories:` via `provider:`.',
  prompts: '**prompts** — LLM prompt templates for AI decisions.\n\nUse `{{ variable }}` placeholders. Memory refs: `{{ memories.<name> }}`.',
  decisions: '**decisions** — AI decision definitions.\n\nExecute an LLM call and emit a configured business event via `op: decision` in actions.',
  memories: '**memories** — Event-driven embedding memory.\n\nPopulated from `source_events`, retrieved during decision prompts.',
  provider: '**provider** — Reference to a logical provider from `providers:` (preferred over legacy `executor:` + `model:`).',
  executor: '**executor** — AI runtime registry key: `mock`, `openai`, `anthropic`, `ollama`.',
  model: '**model** — Default model for this provider or legacy decision/memory binding.',
  instructions: '**instructions** — Prompt template body with `{{ variable }}` placeholders.',
  emits: '**emits** — Business event type emitted when the decision succeeds.',
  output: '**output** — Structured JSON output schema the LLM must return.',
  embedding: '**embedding** — Embedding provider binding for memory vector storage.',
  partition_by: '**partition_by** — Event payload field used as the memory partition key.',
  content: '**content** — Template rendered from event payload when ingesting memory.',
  ref: '**ref** — Decision name for `op: decision`.',
  decision: '**op: decision** — Execute a compiled AI decision and emit its configured event.\n\nMust appear in **`side_effects`** only (external I/O, not replayed). Requires `ref:` and optional `input:` bindings.',
  temperature: '**temperature** — LLM sampling temperature (0 = deterministic).',
  max_tokens: '**max_tokens** — Maximum output tokens for the LLM response.',
  retries: '**retries** — Max retry attempts for transient AI failures.',
};

const NAMESPACE_DOCS: Record<string, string> = {
  event: '**event** namespace — Access to the triggering event\'s payload fields.\n\nUse `event.<field>` (not `event.payload.<field>`).\n\n**Reserved:** `event.ts`, `event.entity_id`, `event.type` always resolve to the envelope fields.',
  entity: '**entity** namespace — Current entity state access in rule expressions.\n\nUse dot notation: `entity.inventory.gold` (not slash: `/inventory/gold`).',
  intent: '**intent** namespace — Incoming action payload in `entity_id_expr` and `preflight`.\n\nTypically `intent.<id_field>` for routing.',
  input: '**input** namespace — Action input fields in expressions.\n\nAlias for `intent` in most contexts.',
  state: '**state** namespace — Entity state access in projection `derive:` expressions.\n\nEquivalent to `entity.*` in rule expressions.',
  projection: '**projection** namespace — Projection field access in expressions.',
  aggregate: '**aggregate** namespace — Aggregate state access.',
  global: '**global** / **platform** namespace — Global or platform-level shared state.',
  platform: '**global** / **platform** namespace — Global or platform-level shared state.',
  it: '**it** namespace — Iterator variable in `filter:`, `remove:`, `find:` where clauses.\n\nExample: `where: "it.qty > 0"`',
  item: '**item** namespace — Iterator variable in `emit_each:` and `for_each:` blocks.\n\nExample: payload values accessed as `item.product_id`.',
  resources: '**resources** namespace — Static lookup table access.\n\nExample: `resources.item_catalog[event.item_id].value`',
  derived: '**derived** namespace — Access previously derived fields within the same projection event processing.',
  envelope: '**envelope** namespace — Commit envelope state access in envelope participant rules.\n\nExample: `envelope.seq`, `envelope.from_wallet_id`.',
};

const BUILTIN_DOCS: Record<string, string> = {
  max: '`max(a, b)` — Returns the larger of two values.',
  min: '`min(a, b)` — Returns the smaller of two values.',
  floor: '`floor(value)` — Floor (round down) a numeric value.',
  size: '`size(array)` — Returns the number of elements in an array. Returns 0 for null.',
  sum: '`sum(array)` — Sum all numeric elements in an array.',
  contains: '`contains(array, value)` — Returns true if the array contains the value.',
  map: '`map(array, expr)` — Transform each element of an array.',
  concat: '`concat(a, b, ...)` — Concatenate strings or values.',
  join: '`join(array, sep)` — Join array elements with a separator string.',
  shard: '`shard(expr, N)` — Returns a shard bucket index 0..N-1. Used for hot-counter distribution.',
  coalesce: '`coalesce(val, fallback)` — Returns fallback if val is **null or empty string**.\n\nUse `isnull` when 0 or false must be preserved.',
  isnull: '`isnull(a, b, ...)` — Returns the first non-null value.\n\nPreserves 0, false, and "" (only substitutes true `null`).',
  format_date: '`format_date(ts)` — Format a timestamp for display.',
  is_prev_day: '`is_prev_day(d1, d2)` — Returns true if d1 is the day before d2.',
  hash: '`hash(value)` — Deterministic hash of a value. Safe to use in derive/rules.',
  LOOKUP_FIELD: '`LOOKUP_FIELD(\'stream\', id_expr, \'/path\')` — Read a field from another entity stream.\n\nUsable in `preflight` and `projection` modes. Triggers a synchronous entity snapshot read.',
  lookup: '`lookup(stream, id_expr).path` — Read from another entity stream in projection derive.\n\nMax 8 calls per projection. Must be O(1) per event.',
};

// ---------------------------------------------------------------------------
// Main hover provider
// ---------------------------------------------------------------------------

export function provideHover(
  doc: CausetDocument,
  position: Position,
  index: WorkspaceIndex,
): Hover | null {
  const w = wordAtPosition(doc.text, position);
  if (!w) return null;
  const { word } = w;
  if (!word) return null;

  const parts: string[] = [];

  // 1. Check if it's a known event
  const evResolution = index.resolveEvent(word) ?? (doc.events?.[word] ? { def: doc.events[word], uri: doc.uri } : undefined);
  if (evResolution) {
    const ev = evResolution.def;
    parts.push(`**Event: \`${word}\`**`);
    if (ev.state) parts.push(`**Entity:** \`${ev.state}\``);
    if (ev.entityExpr) parts.push(`**entity_expr:** \`${ev.entityExpr}\``);
    if (ev.eventKind) parts.push(`**kind:** \`${ev.eventKind}\``);
    if (ev.payload && Object.keys(ev.payload).length > 0) {
      parts.push('\n**Payload fields:**');
      for (const [k, v] of Object.entries(ev.payload)) {
        const t = typeof v === 'string' ? v : (v as any)?.type ?? 'unknown';
        parts.push(`  - \`${k}\`: \`${t}\``);
      }
    }
    const consumers = index.allDocuments()
      .flatMap((d) => Object.entries(d.projections ?? {}))
      .filter(([, p]) => p.sourceEvents.includes(word))
      .map(([n]) => n);
    if (consumers.length > 0) {
      parts.push(`\n**Consumed by projections:** ${consumers.map((c) => `\`${c}\``).join(', ')}`);
    }
    return md(parts.join('\n\n'));
  }

  // 2. Check if it's a known action
  const actResolution = index.resolveAction(word) ?? (doc.actions?.[word] ? { def: doc.actions[word], uri: doc.uri } : undefined);
  if (actResolution) {
    const act = actResolution.def;
    parts.push(`**Action: \`${word}\`**`);
    if (act.state) parts.push(`**Entity:** \`${act.state}\``);
    if (act.entityIdExpr) parts.push(`**entity_id_expr:** \`${act.entityIdExpr}\``);
    if (act.input && Object.keys(act.input).length > 0) {
      parts.push('\n**Input fields:**');
      for (const [k, v] of Object.entries(act.input)) {
        parts.push(`  - \`${k}\`: \`${v.type ?? 'any'}\`${v.required ? ' *(required)*' : ''}`);
      }
    }
    const phases = ['preflight', 'core', 'side_effects'] as const;
    for (const phase of phases) {
      const p = act[phase === 'side_effects' ? 'sideEffects' : phase];
      if (p && p.rules.length > 0) {
        parts.push(`**${phase}:** ${p.rules.length} rule(s)`);
      }
    }
    return md(parts.join('\n\n'));
  }

  // 3. Check if it's a known projection
  const projResolution = index.resolveProjection(word) ?? (doc.projections?.[word] ? { def: doc.projections[word], uri: doc.uri } : undefined);
  if (projResolution) {
    const proj = projResolution.def;
    parts.push(`**Projection: \`${word}\`**`);
    if (proj.target.table) parts.push(`**Table:** \`${proj.target.table}\``);
    if (proj.target.primaryKey?.length) parts.push(`**Primary key:** \`[${proj.target.primaryKey.join(', ')}]\``);
    if (proj.sourceEvents.length) parts.push(`**Source events:** ${proj.sourceEvents.map((e) => `\`${e}\``).join(', ')}`);
    if (proj.fields && Object.keys(proj.fields).length > 0) {
      parts.push('\n**Columns:**');
      for (const [col, type] of Object.entries(proj.fields)) {
        parts.push(`  - \`${col}\`: \`${type}\``);
      }
    }
    if (proj.indexes?.length) {
      parts.push(`\n**Indexes:** ${proj.indexes.map((i) => `\`[${i.columns.join(', ')}]\``).join(', ')}`);
    }
    return md(parts.join('\n\n'));
  }

  // 4. Check if it's a known query
  const qResolution = index.resolveQuery(word) ?? (doc.queries?.[word] ? { def: doc.queries[word], uri: doc.uri } : undefined);
  if (qResolution) {
    const q = qResolution.def;
    parts.push(`**Query: \`${word}\`**`);
    parts.push(`**From:** \`${q.from}\``);
    if (q.input && Object.keys(q.input).length > 0) {
      parts.push('\n**Input:**');
      for (const [k, v] of Object.entries(q.input)) {
        parts.push(`  - \`${k}\`: \`${v.type ?? 'any'}\`${v.required ? ' *(required)*' : ''}`);
      }
    }
    if (q.limit) parts.push(`**Limit:** \`${q.limit}\``);
    return md(parts.join('\n\n'));
  }

  // 5. Check if it's a known entity
  const entResolution = index.resolveEntity(word) ?? (doc.state?.[word] ? { def: doc.state[word], uri: doc.uri } : undefined);
  if (entResolution) {
    const ent = entResolution.def;
    parts.push(`**Entity: \`${word}\`**`);
    if (ent.description) parts.push(ent.description);
    if (ent.entityKey) parts.push(`**entity_key:** \`${ent.entityKey}\``);
    if (ent.fields.length > 0) {
      parts.push('\n**Fields:**');
      for (const f of ent.fields.slice(0, 10)) {
        parts.push(`  - \`${f.name}\`: \`${f.type ?? 'any'}\`${f.required ? ' *(required)*' : ''}`);
      }
      if (ent.fields.length > 10) parts.push(`  - … and ${ent.fields.length - 10} more`);
    }
    return md(parts.join('\n\n'));
  }

  // 6. AI providers, prompts, decisions, memories
  const providerRes = index.resolveProvider(word) ?? (doc.providers?.[word] ? { def: doc.providers[word], uri: doc.uri } : undefined);
  if (providerRes) {
    const p = providerRes.def;
    parts.push(`**Provider: \`${word}\`**`);
    if (p.executor) parts.push(`**executor:** \`${p.executor}\``);
    if (p.model) parts.push(`**model:** \`${p.model}\``);
    if (p.temperature != null) parts.push(`**temperature:** \`${p.temperature}\``);
    if (p.maxTokens != null) parts.push(`**max_tokens:** \`${p.maxTokens}\``);
    parts.push('\nCredentials are configured at runtime (BYOK), never in DSL.');
    return md(parts.join('\n\n'));
  }

  const promptRes = index.resolvePrompt(word) ?? (doc.prompts?.[word] ? { def: doc.prompts[word], uri: doc.uri } : undefined);
  if (promptRes) {
    parts.push(`**Prompt: \`${word}\`**`);
    if (promptRes.def.instructions) {
      const preview = promptRes.def.instructions.slice(0, 200);
      parts.push('```\n' + preview + (promptRes.def.instructions.length > 200 ? '…' : '') + '\n```');
    }
    return md(parts.join('\n\n'));
  }

  const decisionRes = index.resolveDecision(word) ?? (doc.decisions?.[word] ? { def: doc.decisions[word], uri: doc.uri } : undefined);
  if (decisionRes) {
    const d = decisionRes.def;
    parts.push(`**Decision: \`${word}\`**`);
    if (d.provider) parts.push(`**provider:** \`${d.provider}\``);
    if (d.prompt) parts.push(`**prompt:** \`${d.prompt}\``);
    if (d.emits) parts.push(`**emits:** \`${d.emits}\``);
    if (d.memories?.length) parts.push(`**memories:** ${d.memories.map((m) => `\`${m}\``).join(', ')}`);
    return md(parts.join('\n\n'));
  }

  const memoryRes = index.resolveMemory(word) ?? (doc.memories?.[word] ? { def: doc.memories[word], uri: doc.uri } : undefined);
  if (memoryRes) {
    const m = memoryRes.def;
    parts.push(`**Memory: \`${word}\`**`);
    if (m.partitionBy) parts.push(`**partition_by:** \`${m.partitionBy}\``);
    if (m.sourceEvents?.length) parts.push(`**source_events:** ${m.sourceEvents.map((e) => `\`${e}\``).join(', ')}`);
    if (m.embedding?.provider) parts.push(`**embedding.provider:** \`${m.embedding.provider}\``);
    return md(parts.join('\n\n'));
  }

  // 7. DSL key documentation
  if (DSL_KEY_DOCS[word]) {
    return md(DSL_KEY_DOCS[word]);
  }

  // 8. Namespace documentation
  if (NAMESPACE_DOCS[word]) {
    return md(NAMESPACE_DOCS[word]);
  }

  // 9. Builtin functions
  if (BUILTIN_DOCS[word]) {
    return md(BUILTIN_DOCS[word]);
  }

  // 10. SCREAMING_SNAKE not resolved — generic event hint
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(word)) {
    return md(`**\`${word}\`** — Event or action identifier (not found in workspace index). Verify it is registered under \`events:\` or \`actions:\`.`);
  }

  return null;
}

function md(value: string): Hover {
  const content: MarkupContent = { kind: MarkupKind.Markdown, value };
  return { contents: content };
}
