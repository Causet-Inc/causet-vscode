/**
 * Causet diagnostics provider.
 *
 * Validates the semantic model and returns LSP Diagnostic objects.
 * Covers: unknown events, unknown projections, missing PKs, duplicate fields,
 * broken references, invalid ops, non-deterministic expressions, etc.
 */

import {
  Diagnostic,
  DiagnosticSeverity,
  Range as LspRange,
} from 'vscode-languageserver/node.js';
import type { CausetDocument, Range, ActionDefinition, Operation } from 'causet-shared';
import { WorkspaceIndex } from 'causet-shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_OPS = new Set([
  'set', 'add', 'sub', 'unset', 'merge', 'push', 'remove', 'filter', 'find',
  'map', 'sort', 'clone', 'if', 'for_each', 'foreach', 'stop', 'continue',
  'emit', 'emit_each', 'submit', 'decision', 'reject', 'schedule', 'lock', 'unlock',
  'lookup', 'relationship_create', 'relationship_remove', 'compute_regen',
  'upsert', 'delete', 'replace', 'soft_delete', 'bulk_update', 'update', 'increment',
]);

const VALID_AI_EXECUTORS = new Set(['mock', 'openai', 'anthropic', 'ollama']);

const VALID_SCALAR_TYPES = new Set([
  'string', 'number', 'int', 'integer', 'decimal', 'boolean', 'bool',
  'array', 'object', 'any', 'json', 'timestamp', 'datetime', 'date',
  'uuid', 'float', 'double',
]);

const VALID_SQL_TYPES = new Set([
  'TEXT', 'INTEGER', 'BIGINT', 'BOOLEAN', 'FLOAT', 'DOUBLE', 'JSON',
  'UUID', 'TIMESTAMP', 'DECIMAL', 'NUMERIC', 'SMALLINT', 'SERIAL',
  'JSONB', 'BYTEA', 'REAL', 'VARCHAR',
]);

const FORBIDDEN_FUNCTIONS = /\b(now|random|uuid|shuffle|nanoTime)\s*\(/g;

function toLspRange(r: Range): LspRange {
  return {
    start: { line: r.start.line, character: r.start.character },
    end: { line: r.end.line, character: r.end.character },
  };
}

function warn(message: string, range: Range, code?: string): Diagnostic {
  return {
    message,
    range: toLspRange(range),
    severity: DiagnosticSeverity.Warning,
    source: 'causet',
    code,
  };
}

function error(message: string, range: Range, code?: string): Diagnostic {
  return {
    message,
    range: toLspRange(range),
    severity: DiagnosticSeverity.Error,
    source: 'causet',
    code,
  };
}

function info(message: string, range: Range, code?: string): Diagnostic {
  return {
    message,
    range: toLspRange(range),
    severity: DiagnosticSeverity.Information,
    source: 'causet',
    code,
  };
}

// ---------------------------------------------------------------------------
// Forbidden expression check
// ---------------------------------------------------------------------------

function checkExpression(expr: string, range: Range): Diagnostic[] {
  const diags: Diagnostic[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(FORBIDDEN_FUNCTIONS.source, 'g');
  while ((m = re.exec(expr)) !== null) {
    diags.push(error(
      `Non-deterministic function '${m[1]}()' is forbidden — replay would diverge. Use event.ts or a system event for time.`,
      range,
      'CAUSET_NON_DETERMINISTIC',
    ));
  }
  return diags;
}

// ---------------------------------------------------------------------------
// Operation validation
// ---------------------------------------------------------------------------

function* walkOps(ops: Operation[]): Iterable<Operation> {
  for (const op of ops) {
    yield op;
    if (op.then) yield* walkOps(op.then);
    if (op.else) yield* walkOps(op.else);
  }
}

function checkOps(
  ops: Operation[],
  knownEvents: Set<string>,
  knownDecisions: Set<string>,
  phase: string,
): Diagnostic[] {
  const diags: Diagnostic[] = [];

  for (const op of walkOps(ops)) {
    // Unknown op
    if (!VALID_OPS.has(op.op)) {
      diags.push(error(`Unknown operation '${op.op}'.`, op.range, 'CAUSET_OP_UNKNOWN'));
      continue;
    }

    // reject only in preflight
    if (op.op === 'reject' && phase !== 'preflight') {
      diags.push(warn(
        `'op: reject' should only appear in 'preflight' rules.`,
        op.range,
        'CAUSET_REJECT_OUTSIDE_PREFLIGHT',
      ));
    }

    // decision: unknown ref
    if (op.op === 'decision') {
      if (!op.ref) {
        diags.push(error(`'op: decision' requires 'ref:' (decision name).`, op.range, 'CAUSET_DECISION_MISSING_REF'));
      } else if (!knownDecisions.has(op.ref)) {
        diags.push(warn(
          `Unknown decision '${op.ref}'. Declare it under 'decisions:' before referencing.`,
          op.range,
          'CAUSET_UNKNOWN_DECISION_REF',
        ));
      }
      if (phase === 'preflight' || phase === 'core') {
        diags.push(error(
          `'op: decision' must run in 'side_effects' only (external AI is traced but not replayed).`,
          op.range,
          'CAUSET_DECISION_NOT_SIDE_EFFECT',
        ));
      }
    }

    // emit: unknown event_type
    if ((op.op === 'emit' || op.op === 'emit_each') && op.eventType) {
      if (!knownEvents.has(op.eventType)) {
        diags.push(warn(
          `Unknown event '${op.eventType}'. Register it under 'events:' before emitting.`,
          op.range,
          'CAUSET_UNKNOWN_EVENT_TYPE',
        ));
      }
    }

    // set / add / sub: path required
    if ((op.op === 'set' || op.op === 'add' || op.op === 'sub') && !op.path) {
      diags.push(error(`'op: ${op.op}' requires a 'path:' field.`, op.range, 'CAUSET_MISSING_PATH'));
    }

    // filter/remove/find: where should be a plain string (catch common mistake)
    if ((op.op === 'filter' || op.op === 'remove' || op.op === 'find') && op.where) {
      if (typeof op.where === 'object') {
        diags.push(error(
          `'where:' in '${op.op}' must be a plain string (e.g. where: "it.qty > 0"), not an object { expr: ... }.`,
          op.range,
          'CAUSET_FILTER_WHERE_OBJECT',
        ));
      }
    }

    // Check value expressions for non-determinism
    if (op.value && typeof op.value === 'string') {
      diags.push(...checkExpression(op.value, op.range));
    }
  }

  return diags;
}

// ---------------------------------------------------------------------------
// Main diagnostics function
// ---------------------------------------------------------------------------

export function provideDiagnostics(doc: CausetDocument, index: WorkspaceIndex): Diagnostic[] {
  const diags: Diagnostic[] = [];

  // Propagate parse errors
  for (const err of doc.errors) {
    diags.push({
      message: err.message,
      range: toLspRange(err.range),
      severity: err.severity === 'error'
        ? DiagnosticSeverity.Error
        : err.severity === 'warning'
        ? DiagnosticSeverity.Warning
        : DiagnosticSeverity.Information,
      source: 'causet',
      code: err.code,
    });
  }

  // Build local symbol sets (also pull from workspace index for cross-file)
  const localEvents = new Set(Object.keys(doc.events ?? {}));
  const localEntities = new Set(Object.keys(doc.state ?? {}));
  const localProjections = new Set(Object.keys(doc.projections ?? {}));
  const localQueries = new Set(Object.keys(doc.queries ?? {}));
  const localRelationships = new Set(Object.keys(doc.relationships ?? {}));
  const wsEvents = new Set(index.allEventNames());
  const wsEntities = new Set(index.allEntityNames());
  const wsProjections = new Set(index.allProjectionNames());

  const allEvents = new Set([...localEvents, ...wsEvents]);
  const allEntities = new Set([...localEntities, ...wsEntities]);
  const allProjections = new Set([...localProjections, ...wsProjections]);
  const localDecisions = new Set(Object.keys(doc.decisions ?? {}));
  const localPrompts = new Set(Object.keys(doc.prompts ?? {}));
  const localMemories = new Set(Object.keys(doc.memories ?? {}));
  const localProviders = new Set(Object.keys(doc.providers ?? {}));
  const wsDecisions = new Set(index.allDecisionNames());
  const wsPrompts = new Set(index.allPromptNames());
  const wsMemories = new Set(index.allMemoryNames());
  const wsProviders = new Set(index.allProviderNames());
  const allDecisions = new Set([...localDecisions, ...wsDecisions]);
  const allPrompts = new Set([...localPrompts, ...wsPrompts]);
  const allMemories = new Set([...localMemories, ...wsMemories]);
  const allProviders = new Set([...localProviders, ...wsProviders]);

  // ---------------------------------------------------------------------------
  // Validate state
  // ---------------------------------------------------------------------------
  for (const [name, entity] of Object.entries(doc.state ?? {})) {
    if (!entity.entityKey) {
      diags.push(warn(`Entity '${name}' is missing 'entity_key:'.`, entity.range, 'CAUSET_MISSING_ENTITY_KEY'));
    }
    const seenFields = new Set<string>();
    for (const field of entity.fields) {
      if (seenFields.has(field.name)) {
        diags.push(error(`Duplicate field '${field.name}' in entity '${name}'.`, field.range, 'CAUSET_DUPLICATE_FIELD'));
      }
      seenFields.add(field.name);
      if (field.type && !VALID_SCALAR_TYPES.has(field.type)) {
        diags.push(warn(`Unknown type '${field.type}' on field '${field.name}' in entity '${name}'.`, field.range, 'CAUSET_UNKNOWN_TYPE'));
      }
      if (field.type === 'array' && !field.itemType) {
        diags.push(info(`Array field '${field.name}' in entity '${name}' should declare 'item_type:'.`, field.range, 'CAUSET_ARRAY_NO_ITEM_TYPE'));
      }
      if ((field.type === 'array' || field.type === 'object') && field.default === undefined) {
        diags.push(info(
          `Field '${field.name}' (type: ${field.type}) in entity '${name}' has no 'default:'. Missing defaults cause null errors at runtime.`,
          field.range,
          'CAUSET_MISSING_DEFAULT',
        ));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Validate events
  // ---------------------------------------------------------------------------
  for (const [name, ev] of Object.entries(doc.events ?? {})) {
    if (ev.state && !allEntities.has(ev.state)) {
      diags.push(warn(`Event '${name}' references unknown entity '${ev.state}'. Define it under 'state:'.`, ev.range, 'CAUSET_UNKNOWN_ENTITY'));
    }
    if (!ev.entityExpr) {
      diags.push(info(`Event '${name}' is missing 'entity_expr:'.`, ev.range, 'CAUSET_MISSING_ENTITY_EXPR'));
    }
    // Reserved payload field names
    const reserved = new Set(['type', 'ts', 'entity_id']);
    for (const pf of Object.keys(ev.payload ?? {})) {
      if (reserved.has(pf)) {
        diags.push(error(
          `Payload field '${pf}' in event '${name}' shadows a reserved envelope field. Rename it (e.g. 'notification_type', 'created_at').`,
          ev.range,
          'CAUSET_RESERVED_PAYLOAD_FIELD',
        ));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Validate actions
  // ---------------------------------------------------------------------------
  for (const [name, action] of Object.entries(doc.actions ?? {})) {
    if (action.state && !allEntities.has(action.state)) {
      diags.push(warn(`Action '${name}' references unknown entity '${action.state}'.`, action.range, 'CAUSET_UNKNOWN_ENTITY'));
    }
    if (!action.entityIdExpr) {
      diags.push(info(`Action '${name}' is missing 'entity_id_expr:'.`, action.range, 'CAUSET_MISSING_ENTITY_ID_EXPR'));
    }
    if (!action.core && !action.preflight && !action.sideEffects) {
      diags.push(info(`Action '${name}' has no rule phases (preflight/core/side_effects).`, action.range, 'CAUSET_EMPTY_ACTION'));
    }

    // Validate rule phases
    for (const [phase, phaseObj] of [
      ['preflight', action.preflight],
      ['core', action.core],
      ['side_effects', action.sideEffects],
    ] as Array<[string, typeof action.core]>) {
      if (!phaseObj) continue;
      for (const rule of phaseObj.rules) {
        // Check when expression
        if (rule.when?.raw) {
          diags.push(...checkExpression(rule.when.raw, rule.when.range));
        }
        // Check ops
        diags.push(...checkOps(rule.then, allEvents, allDecisions, phase));
      }
    }

    // Input reserved names
    const reserved = new Set(['type', 'ts', 'entity_id']);
    for (const iName of Object.keys(action.input ?? {})) {
      if (reserved.has(iName)) {
        diags.push(warn(
          `Input field '${iName}' in action '${name}' shadows a reserved name.`,
          action.range,
          'CAUSET_RESERVED_INPUT_FIELD',
        ));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Validate projections
  // ---------------------------------------------------------------------------
  for (const [name, proj] of Object.entries(doc.projections ?? {})) {
    // source_events must be registered
    for (const evName of proj.sourceEvents) {
      if (!allEvents.has(evName)) {
        diags.push(warn(
          `Projection '${name}' source_event '${evName}' is not registered under 'events:'.`,
          proj.range,
          'CAUSET_UNKNOWN_SOURCE_EVENT',
        ));
      }
    }

    // target.table required
    if (!proj.target.table) {
      diags.push(error(`Projection '${name}' is missing 'target.table:'.`, proj.range, 'CAUSET_MISSING_TABLE'));
    }

    // primary_key required
    if (!proj.target.primaryKey || proj.target.primaryKey.length === 0) {
      diags.push(error(`Projection '${name}' is missing 'target.primary_key:'.`, proj.range, 'CAUSET_MISSING_PRIMARY_KEY'));
    }

    // Must have mutations or aggregates
    const hasMutations = proj.mutations && Object.keys(proj.mutations).length > 0;
    const hasAggregates = proj.aggregates && Object.keys(proj.aggregates).length > 0;
    if (!hasMutations && !hasAggregates) {
      diags.push(error(
        `Projection '${name}' has neither 'mutations:' nor 'aggregates:'. The compiler requires at least one.`,
        proj.range,
        'CAUSET_PROJECTION_NO_WRITE_OP',
      ));
    }

    // PK columns must appear in derive
    const derivedFields = new Set(Object.keys(proj.derive ?? {}));
    for (const pk of (proj.target.primaryKey ?? [])) {
      if (!derivedFields.has(pk) && pk !== 'shard_id' && pk !== 'bucket_ts') {
        diags.push(warn(
          `Primary key column '${pk}' in projection '${name}' is not found in 'derive:'. Add a derive expression for it.`,
          proj.range,
          'CAUSET_PK_NOT_DERIVED',
        ));
      }
    }

    // mutation event references
    for (const evName of Object.keys(proj.mutations ?? {})) {
      if (!allEvents.has(evName)) {
        diags.push(warn(
          `Projection '${name}' mutation key '${evName}' is not a registered event.`,
          proj.range,
          'CAUSET_UNKNOWN_MUTATION_EVENT',
        ));
      }
    }

    // aggregate event references
    for (const evName of Object.keys(proj.aggregates ?? {})) {
      if (!allEvents.has(evName)) {
        diags.push(warn(
          `Projection '${name}' aggregate key '${evName}' is not a registered event.`,
          proj.range,
          'CAUSET_UNKNOWN_AGGREGATE_EVENT',
        ));
      }
    }

    // fields SQL types validation
    for (const [colName, colType] of Object.entries(proj.fields ?? {})) {
      if (!VALID_SQL_TYPES.has(colType as string)) {
        diags.push(info(
          `Unknown SQL type '${colType}' on column '${colName}' in projection '${name}'.`,
          proj.range,
          'CAUSET_UNKNOWN_SQL_TYPE',
        ));
      }
    }

    // derive expression non-determinism
    for (const [field, expr] of Object.entries(proj.derive ?? {})) {
      if (typeof expr === 'string') {
        diags.push(...checkExpression(expr, proj.range));
      }
    }

    // Warn when fields: is missing (type inference gotcha)
    if (!proj.fields || Object.keys(proj.fields).length === 0) {
      diags.push(info(
        `Projection '${name}' has no 'fields:' block. Omitting it causes type inference — boolean/bigint columns default to TEXT and break queries.`,
        proj.range,
        'CAUSET_MISSING_FIELDS_BLOCK',
      ));
    }
  }

  // ---------------------------------------------------------------------------
  // Validate queries
  // ---------------------------------------------------------------------------
  for (const [name, q] of Object.entries(doc.queries ?? {})) {
    if (!q.from) {
      diags.push(error(`Query '${name}' is missing 'from:'.`, q.range, 'CAUSET_MISSING_FROM'));
    } else if (!allProjections.has(q.from)) {
      diags.push(warn(
        `Query '${name}' reads from unknown projection '${q.from}'.`,
        q.range,
        'CAUSET_UNKNOWN_PROJECTION',
      ));
    }

    // group_by without aggregate
    if (q.groupBy && q.groupBy.length > 0 && !q.aggregate) {
      diags.push(info(
        `Query '${name}' has 'group_by:' but no 'aggregate:'. Count/sum queries need the 'aggregate:' block.`,
        q.range,
        'CAUSET_GROUP_BY_NO_AGGREGATE',
      ));
    }

    // limit missing on non-aggregate query
    if (!q.limit && !q.aggregate) {
      diags.push(info(
        `Query '${name}' has no 'limit:'. Consider adding one to cap result set size.`,
        q.range,
        'CAUSET_MISSING_LIMIT',
      ));
    }

    // Validate join projections
    for (const [joinProj] of Object.entries(q.joins ?? {})) {
      if (!allProjections.has(joinProj)) {
        diags.push(warn(
          `Query '${name}' joins unknown projection '${joinProj}'.`,
          q.range,
          'CAUSET_UNKNOWN_JOIN_PROJECTION',
        ));
      }
    }

    // Too many joins
    if (q.joins && Object.keys(q.joins).length > 5) {
      diags.push(warn(
        `Query '${name}' has ${Object.keys(q.joins).length} joins (max 5). Denormalize a projection instead.`,
        q.range,
        'CAUSET_TOO_MANY_JOINS',
      ));
    }
  }

  // ---------------------------------------------------------------------------
  // Validate relationships
  // ---------------------------------------------------------------------------
  for (const [name, rel] of Object.entries(doc.relationships ?? {})) {
    if (!allEntities.has(rel.from)) {
      diags.push(warn(`Relationship '${name}' 'from:' entity '${rel.from}' not found.`, rel.range, 'CAUSET_UNKNOWN_ENTITY'));
    }
    if (!allEntities.has(rel.to)) {
      diags.push(warn(`Relationship '${name}' 'to:' entity '${rel.to}' not found.`, rel.range, 'CAUSET_UNKNOWN_ENTITY'));
    }
    if (rel.emitEvents?.created && !allEvents.has(rel.emitEvents.created)) {
      diags.push(warn(`Relationship '${name}' emit_events.created '${rel.emitEvents.created}' not registered.`, rel.range, 'CAUSET_UNKNOWN_EVENT_TYPE'));
    }
    if (rel.emitEvents?.removed && !allEvents.has(rel.emitEvents.removed)) {
      diags.push(warn(`Relationship '${name}' emit_events.removed '${rel.emitEvents.removed}' not registered.`, rel.range, 'CAUSET_UNKNOWN_EVENT_TYPE'));
    }
  }

  // ---------------------------------------------------------------------------
  // Validate listeners
  // ---------------------------------------------------------------------------
  for (const listener of (doc.listeners ?? [])) {
    if (!allEvents.has(listener.on)) {
      diags.push(warn(
        `Listener 'on: ${listener.on}' — event not registered under 'events:'.`,
        listener.range,
        'CAUSET_UNKNOWN_EVENT_TYPE',
      ));
    }
  }

  // ---------------------------------------------------------------------------
  // Validate AI providers
  // ---------------------------------------------------------------------------
  for (const [name, provider] of Object.entries(doc.providers ?? {})) {
    if (!provider.executor) {
      diags.push(error(`Provider '${name}' is missing 'executor:'.`, provider.range, 'CAUSET_PROVIDER_MISSING_EXECUTOR'));
    } else if (!VALID_AI_EXECUTORS.has(provider.executor)) {
      diags.push(warn(
        `Provider '${name}' executor '${provider.executor}' is not a known executor (mock, openai, anthropic, ollama).`,
        provider.range,
        'CAUSET_UNKNOWN_EXECUTOR',
      ));
    }
  }

  // ---------------------------------------------------------------------------
  // Validate prompts
  // ---------------------------------------------------------------------------
  for (const [name, prompt] of Object.entries(doc.prompts ?? {})) {
    if (!prompt.instructions) {
      diags.push(error(`Prompt '${name}' is missing 'instructions:'.`, prompt.range, 'CAUSET_PROMPT_MISSING_INSTRUCTIONS'));
    }
  }

  // ---------------------------------------------------------------------------
  // Validate decisions
  // ---------------------------------------------------------------------------
  for (const [name, decision] of Object.entries(doc.decisions ?? {})) {
    if (!decision.provider && !decision.executor) {
      diags.push(error(
        `Decision '${name}' must declare 'provider:' or legacy 'executor:'.`,
        decision.range,
        'CAUSET_DECISION_MISSING_PROVIDER',
      ));
    }
    if (decision.provider && !allProviders.has(decision.provider)) {
      diags.push(warn(
        `Decision '${name}' references unknown provider '${decision.provider}'.`,
        decision.range,
        'CAUSET_UNKNOWN_PROVIDER_REF',
      ));
    }
    if (decision.prompt && !allPrompts.has(decision.prompt)) {
      diags.push(warn(
        `Decision '${name}' references unknown prompt '${decision.prompt}'.`,
        decision.range,
        'CAUSET_UNKNOWN_PROMPT_REF',
      ));
    }
    if (decision.emits && !allEvents.has(decision.emits)) {
      diags.push(warn(
        `Decision '${name}' emits unknown event '${decision.emits}'.`,
        decision.range,
        'CAUSET_UNKNOWN_EMITS_EVENT',
      ));
    }
    if (decision.memories) {
      for (const memRef of decision.memories) {
        if (!allMemories.has(memRef)) {
          diags.push(warn(
            `Decision '${name}' references unknown memory '${memRef}'.`,
            decision.range,
            'CAUSET_UNKNOWN_MEMORY_REF',
          ));
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Validate memories
  // ---------------------------------------------------------------------------
  for (const [name, memory] of Object.entries(doc.memories ?? {})) {
    if (!memory.sourceEvents || memory.sourceEvents.length === 0) {
      diags.push(error(`Memory '${name}' is missing 'source_events:'.`, memory.range, 'CAUSET_MEMORY_MISSING_SOURCE_EVENTS'));
    } else {
      for (const ev of memory.sourceEvents) {
        if (!allEvents.has(ev)) {
          diags.push(warn(
            `Memory '${name}' source_event '${ev}' is not registered under 'events:'.`,
            memory.range,
            'CAUSET_UNKNOWN_SOURCE_EVENT',
          ));
        }
      }
    }
    if (!memory.partitionBy) {
      diags.push(error(`Memory '${name}' is missing 'partition_by:'.`, memory.range, 'CAUSET_MEMORY_MISSING_PARTITION'));
    }
    if (!memory.content) {
      diags.push(error(`Memory '${name}' is missing 'content:' template.`, memory.range, 'CAUSET_MEMORY_MISSING_CONTENT'));
    }
    const emb = memory.embedding;
    if (!emb?.provider && !(emb?.executor && emb?.model)) {
      diags.push(error(
        `Memory '${name}' embedding must declare 'provider:' or legacy 'executor:' + 'model:'.`,
        memory.range,
        'CAUSET_MEMORY_MISSING_EMBEDDING',
      ));
    }
    if (emb?.provider && !allProviders.has(emb.provider)) {
      diags.push(warn(
        `Memory '${name}' references unknown embedding provider '${emb.provider}'.`,
        memory.range,
        'CAUSET_UNKNOWN_PROVIDER_REF',
      ));
    }
  }

  return diags;
}
