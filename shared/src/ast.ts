/**
 * Causet DSL – Abstract Syntax Tree node types.
 *
 * The parser uses the `yaml` package to produce a Concrete Syntax Tree (CST)
 * with exact line/column offsets, then maps those onto these typed nodes so
 * every provider (hover, go-to-def, rename, etc.) always works from the same
 * position-aware representation.
 */

// ---------------------------------------------------------------------------
// Position helpers
// ---------------------------------------------------------------------------

export interface Position {
  line: number;   // 0-based
  character: number; // 0-based
}

export interface Range {
  start: Position;
  end: Position;
}

/** A node carries the range of its key (name) inside the source text. */
export interface Located {
  range: Range;
  /** Range of the *value* span (may equal range for scalars). */
  valueRange?: Range;
}

// ---------------------------------------------------------------------------
// Leaf / scalar
// ---------------------------------------------------------------------------

export interface StringLiteral extends Located {
  kind: 'string';
  value: string;
}

export interface NumberLiteral extends Located {
  kind: 'number';
  value: number;
}

export interface BooleanLiteral extends Located {
  kind: 'boolean';
  value: boolean;
}

export interface NullLiteral extends Located {
  kind: 'null';
}

export type ScalarLiteral = StringLiteral | NumberLiteral | BooleanLiteral | NullLiteral;

// ---------------------------------------------------------------------------
// Field / input / payload entry
// ---------------------------------------------------------------------------

export type FieldType =
  | 'string' | 'number' | 'int' | 'integer' | 'decimal'
  | 'boolean' | 'bool' | 'array' | 'object' | 'any'
  | 'json' | 'timestamp' | 'datetime' | 'date' | 'uuid'
  | 'float' | 'double';

export type SqlType =
  | 'TEXT' | 'INTEGER' | 'INT' | 'BIGINT' | 'BOOLEAN' | 'FLOAT' | 'DOUBLE'
  | 'JSON' | 'UUID' | 'TIMESTAMP' | 'DECIMAL' | 'NUMERIC' | 'SMALLINT'
  | 'TINYINT' | 'CHAR' | 'VARCHAR' | 'REAL';

export interface FieldDefinition extends Located {
  kind: 'field';
  name: string;
  type?: FieldType;
  sqlType?: SqlType;
  required?: boolean;
  default?: unknown;
  description?: string;
  itemType?: FieldType;
  itemFields?: Record<string, FieldDefinition>;
  nullable?: boolean;
}

export interface InputField extends Located {
  kind: 'inputField';
  name: string;
  type?: FieldType;
  required?: boolean;
  description?: string;
}

// ---------------------------------------------------------------------------
// Expression (inline DSL expression string)
// ---------------------------------------------------------------------------

export interface Expression extends Located {
  kind: 'expression';
  raw: string;
  /** Tokens found inside this expression (namespaces, builtins, etc.) */
  tokens?: ExpressionToken[];
}

export type ExpressionTokenKind =
  | 'namespace'        // event, entity, intent, state, projection, input, it, item
  | 'member'           // .field_name after namespace
  | 'builtin'          // max, min, size, concat, isnull, coalesce, ...
  | 'eventRef'         // EVENT_NAME inside expression
  | 'operator'         // ==, !=, >=, <=, &&, ||, ?, :, ?:
  | 'literal';

export interface ExpressionToken {
  kind: ExpressionTokenKind;
  value: string;
  range: Range;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export type OpKind =
  | 'set' | 'add' | 'sub' | 'unset' | 'merge' | 'push'
  | 'remove' | 'filter' | 'find' | 'map' | 'sort' | 'clone'
  | 'if' | 'for_each' | 'foreach' | 'stop' | 'continue'
  | 'emit' | 'emit_each' | 'submit' | 'decision' | 'reject' | 'schedule'
  | 'lock' | 'unlock' | 'lookup'
  | 'relationship_create' | 'relationship_remove'
  | 'compute_regen'
  | 'upsert' | 'delete' | 'replace' | 'soft_delete' | 'bulk_update' | 'update'
  | 'increment';

export interface Operation extends Located {
  kind: 'operation';
  op: OpKind;
  path?: string;
  value?: unknown;
  eventType?: string;
  payload?: Record<string, unknown>;
  targetStream?: string;
  targetEntity?: string;
  intentType?: string;
  where?: string;
  code?: string;
  message?: string;
  into?: string;
  as?: string;
  from?: string;
  by?: string;
  /** Nested ops for `if`, `for_each` etc. */
  then?: Operation[];
  else?: Operation[];
  delaySeconds?: number;
  relationship?: string;
  toId?: string;
  /** Decision ref for `op: decision` */
  ref?: string;
  /** Decision input bindings for `op: decision` */
  input?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Rule
// ---------------------------------------------------------------------------

export interface Rule extends Located {
  kind: 'rule';
  name: string;
  when?: Expression | null;
  then: Operation[];
  priority?: number;
}

export interface RulePhase extends Located {
  kind: 'rulePhase';
  rules: Rule[];
}

// ---------------------------------------------------------------------------
// State / Entity
// ---------------------------------------------------------------------------

export interface EntityDefinition extends Located {
  kind: 'entity';
  name: string;
  entityKey?: string;
  description?: string;
  fields: FieldDefinition[];
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface EventDefinition extends Located {
  kind: 'event';
  name: string;
  state?: string;
  entityExpr?: string;
  payload?: Record<string, string | FieldDefinition>;
  eventKind?: 'event' | 'system' | 'fact' | 'compute' | 'command';
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface ActionDefinition extends Located {
  kind: 'action';
  name: string;
  state?: string;
  entityIdExpr?: string;
  description?: string;
  input?: Record<string, InputField>;
  preflight?: RulePhase;
  core?: RulePhase;
  sideEffects?: RulePhase;
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

export interface ProjectionTarget extends Located {
  table: string;
  primaryKey: string[];
  entityKey?: string;
  entityExpr?: string;
}

export interface AggregateSpec extends Located {
  op: 'add' | 'sub' | 'set';
  by?: number | string;
  floor?: number;
}

export type MutationOp = 'upsert' | 'delete' | 'replace';

export interface MutationSpec extends Located {
  op: MutationOp;
  condition?: string;
}

export interface IndexSpec extends Located {
  columns: string[];
  direction?: 'asc' | 'desc';
  unique?: boolean;
}

export type PartitionStrategy = 'range' | 'hash' | 'list';

export interface PartitionSpec extends Located {
  strategy: PartitionStrategy;
  field?: string;
  /** range partition interval e.g. "1 month" */
  interval?: string;
  /** hash partition count */
  partitions?: number;
  precreate?: number;
  retention?: string;
  defaultPartition?: boolean;
}

export interface ProjectionDefinition extends Located {
  kind: 'projection';
  name: string;
  description?: string;
  sourceEvents: string[];
  target: ProjectionTarget;
  fields?: Record<string, SqlType | string>;
  derive?: Record<string, string>;
  mutations?: Record<string, MutationSpec>;
  aggregates?: Record<string, Record<string, AggregateSpec>>;
  indexes?: IndexSpec[];
  bucket?: { field: string; interval: string };
  partition?: PartitionSpec;
  override?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export type WhereOperator =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'in' | 'nin' | 'gte_window' | 'like' | 'ilike';

export interface WhereClause {
  field: string;
  operator: WhereOperator;
  value: unknown;
}

export interface JoinSpec extends Located {
  projection: string;
  type?: 'left' | 'right' | 'inner';
  on?: Record<string, string> | { pairs: Array<{ left: string; right: string }> };
  fields?: string[];
}

export interface QueryDefinition extends Located {
  kind: 'query';
  name: string;
  from: string;
  input?: Record<string, InputField>;
  fields?: string[];
  where?: Record<string, Partial<Record<WhereOperator, unknown>>>;
  orderBy?: Record<string, 'asc' | 'desc'>;
  joins?: Record<string, JoinSpec>;
  groupBy?: string[];
  aggregate?: Record<string, unknown>;
  limit?: number;
  distinct?: boolean;
  coalesceZero?: string[];
  window?: { allowed: string[] };
}

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

export interface RelationshipDefinition extends Located {
  kind: 'relationship';
  name: string;
  from: string;
  to: string;
  cardinality: 'many_to_many' | 'one_to_many' | 'one_to_one';
  unique?: boolean;
  emitEvents?: { created?: string; removed?: string };
}

// ---------------------------------------------------------------------------
// Listeners
// ---------------------------------------------------------------------------

export interface ListenerOperation extends Located {
  op: string;
  field?: string;
  value?: unknown;
}

export interface ListenerDefinition extends Located {
  kind: 'listener';
  on: string;
  where?: string;
  priority?: number;
  mutate: ListenerOperation[];
}

// ---------------------------------------------------------------------------
// AI Decisions (prompts, decisions, memories)
// ---------------------------------------------------------------------------

export interface PromptDefinition extends Located {
  kind: 'prompt';
  name: string;
  instructions?: string;
}

export interface DecisionSchemaField extends Located {
  type?: string;
  required?: boolean;
}

export interface DecisionDefinition extends Located {
  kind: 'decision';
  name: string;
  /** Logical provider reference (preferred). */
  provider?: string;
  executor?: string;
  model?: string;
  prompt?: string;
  emits?: string;
  input?: Record<string, DecisionSchemaField>;
  output?: Record<string, DecisionSchemaField>;
  memories?: string[];
  temperature?: number;
  maxTokens?: number;
  timeout?: string;
  retries?: number;
}

export interface MemoryEmbeddingConfig {
  provider?: string;
  executor?: string;
  model?: string;
}

export interface ProviderDefinition extends Located {
  kind: 'provider';
  name: string;
  executor?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: string;
}

export interface MemoryDefinition extends Located {
  kind: 'memory';
  name: string;
  sourceEvents?: string[];
  partitionBy?: string;
  embedding?: MemoryEmbeddingConfig;
  content?: string;
}

// ---------------------------------------------------------------------------
// Sagas
// ---------------------------------------------------------------------------

export interface SagaStep extends Located {
  name: string;
  on?: string;
  set?: Record<string, unknown>;
  end?: boolean;
}

export interface SagaDefinition extends Located {
  kind: 'saga';
  name: string;
  state: string;
  statePath: string;
  steps: SagaStep[];
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export interface ResourceDefinition extends Located {
  kind: 'resource';
  name: string;
  entries: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Commit Envelopes  (2-phase-commit distributed transaction protocol)
// ---------------------------------------------------------------------------

export interface CommitEnvelopeLifecycle {
  prepareEvent?: string;
  preparedEvent?: string;
  commitEvent?: string;
  abortEvent?: string;
}

export interface CommitEnvelopeTimeout {
  abortAfterSeconds?: number;
  tickEvent?: string;
}

export interface CausalOrdering {
  mode?: 'per_entity' | 'per_aggregate' | 'global';
  cursorField?: string;
  seqSource?: string;
}

export interface VisibilityGate {
  strategy?: 'shadow_state' | 'immediate';
  visiblePath?: string;
  pendingPath?: string;
}

export interface CommitEnvelopeParticipant extends Located {
  name: string;
  state?: string;
  entityExpr?: string;
  deltaExpr?: string;
  visibilityGate?: VisibilityGate;
}

export interface CommitEnvelopeDefinition extends Located {
  kind: 'commitEnvelope';
  name: string;
  startAction?: string;
  envelopeState?: string;
  envelopeStatePath?: string;
  lifecycle?: CommitEnvelopeLifecycle;
  timeout?: CommitEnvelopeTimeout;
  causalOrdering?: CausalOrdering;
  participants?: CommitEnvelopeParticipant[];
}

// ---------------------------------------------------------------------------
// Includes / App manifest
// ---------------------------------------------------------------------------

export interface IncludesSection extends Located {
  states?: string[];
  events?: string[];
  actions?: string[];
  projections?: string[];
  queries?: string[];
  relationships?: string[];
  sagas?: string[];
  resources?: string[];
  commitEnvelopes?: string[];
  listeners?: string[];
  prompts?: string[];
  decisions?: string[];
  memories?: string[];
  providers?: string[];
}

// ---------------------------------------------------------------------------
// Root document
// ---------------------------------------------------------------------------

export interface CausetDocument {
  uri: string;
  /** Source text (for position re-mapping) */
  text: string;
  dslVersion?: number;
  app?: string;
  includes?: IncludesSection;

  state?: Record<string, EntityDefinition>;
  events?: Record<string, EventDefinition>;
  actions?: Record<string, ActionDefinition>;
  projections?: Record<string, ProjectionDefinition>;
  queries?: Record<string, QueryDefinition>;
  relationships?: Record<string, RelationshipDefinition>;
  listeners?: ListenerDefinition[];
  sagas?: Record<string, SagaDefinition>;
  resources?: Record<string, ResourceDefinition>;
  commitEnvelopes?: Record<string, CommitEnvelopeDefinition>;
  prompts?: Record<string, PromptDefinition>;
  decisions?: Record<string, DecisionDefinition>;
  memories?: Record<string, MemoryDefinition>;
  providers?: Record<string, ProviderDefinition>;

  /** Parse / structural errors */
  errors: ParseError[];
}

export interface ParseError {
  message: string;
  range: Range;
  severity: 'error' | 'warning' | 'info';
  code?: string;
}

// ---------------------------------------------------------------------------
// Symbol index entry (for workspace-level search)
// ---------------------------------------------------------------------------

export type SymbolKind =
  | 'event' | 'action' | 'entity' | 'projection' | 'query'
  | 'relationship' | 'saga' | 'resource' | 'field' | 'commitEnvelope'
  | 'prompt' | 'decision' | 'memory' | 'provider';

export interface WorkspaceSymbol {
  name: string;
  kind: SymbolKind;
  uri: string;
  range: Range;
  detail?: string;
  /** For cross-file references */
  containerName?: string;
}
