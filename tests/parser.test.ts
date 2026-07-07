/**
 * Unit tests for the Causet DSL parser.
 *
 * Run with: node --experimental-vm-modules node_modules/.bin/jest
 */

import { parseCausetDocument } from 'causet-shared';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function parse(text: string) {
  return parseCausetDocument('file:///test.causet', text);
}

// ---------------------------------------------------------------------------
// App manifest
// ---------------------------------------------------------------------------

describe('App manifest', () => {
  test('parses dsl_version and app name', () => {
    const { document } = parse(`dsl_version: 1\napp: my_app\n`);
    expect(document.dslVersion).toBe(1);
    expect(document.app).toBe('my_app');
  });

  test('parses includes glob patterns', () => {
    const { document } = parse(`
dsl_version: 1
app: my_app
includes:
  states:
    - ./states/*.state.causet
  events:
    - ./events/*.events.causet
  actions:
    - ./actions/*.actions.causet
`);
    expect(document.includes?.states).toEqual(['./states/*.state.causet']);
    expect(document.includes?.events).toEqual(['./events/*.events.causet']);
    expect(document.includes?.actions).toEqual(['./actions/*.actions.causet']);
  });
});

// ---------------------------------------------------------------------------
// State / entity
// ---------------------------------------------------------------------------

describe('State parser', () => {
  test('parses entity with entity_key and fields', () => {
    const { document } = parse(`
state:
  item:
    entity_key: item_id
    description: Test item entity
    fields:
      - name: title
        type: string
        default: ""
      - name: count
        type: int
        default: 0
`);
    const item = document.state?.item;
    expect(item).toBeDefined();
    expect(item!.entityKey).toBe('item_id');
    expect(item!.description).toBe('Test item entity');
    expect(item!.fields).toHaveLength(2);
    expect(item!.fields[0].name).toBe('title');
    expect(item!.fields[0].type).toBe('string');
    expect(item!.fields[1].name).toBe('count');
    expect(item!.fields[1].type).toBe('int');
  });

  test('parses array and object defaults', () => {
    const { document } = parse(`
state:
  wallet:
    entity_key: wallet_id
    fields:
      - name: pending_envelopes
        type: array
        item_type: object
        default: []
      - name: saga_state
        type: object
        default: {}
      - name: social/friends
        type: array
        item_type: string
        default: []
`);
    const wallet = document.state?.wallet;
    expect(wallet!.fields[0].default).toEqual([]);
    expect(wallet!.fields[1].default).toEqual({});
    expect(wallet!.fields[2].default).toEqual([]);
  });

  test('records position for entity definition', () => {
    const { document } = parse(`
state:
  player:
    entity_key: player_id
    fields: []
`);
    const player = document.state?.player;
    expect(player?.range.start.line).toBeGreaterThanOrEqual(0);
  });

  test('emits symbol for each entity', () => {
    const { symbols } = parse(`
state:
  player:
    entity_key: player_id
    fields: []
  item:
    entity_key: item_id
    fields: []
`);
    const entitySymbols = symbols.filter((s) => s.kind === 'entity');
    expect(entitySymbols.map((s) => s.name).sort()).toEqual(['item', 'player']);
  });
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

describe('Events parser', () => {
  test('parses event with payload', () => {
    const { document } = parse(`
events:
  ITEM_CREATED:
    state: item
    entity_expr: event.item_id
    payload:
      item_id: string
      title: string
`);
    const ev = document.events?.ITEM_CREATED;
    expect(ev).toBeDefined();
    expect(ev!.state).toBe('item');
    expect(ev!.entityExpr).toBe('event.item_id');
    expect(ev!.payload?.item_id).toBe('string');
    expect(ev!.payload?.title).toBe('string');
  });

  test('emits symbol for each event', () => {
    const { symbols } = parse(`
events:
  ORDER_PLACED:
    state: order
    entity_expr: event.order_id
    payload:
      order_id: string
  ORDER_CANCELLED:
    state: order
    entity_expr: event.order_id
    payload:
      order_id: string
`);
    const evSymbols = symbols.filter((s) => s.kind === 'event');
    expect(evSymbols.map((s) => s.name).sort()).toEqual(['ORDER_CANCELLED', 'ORDER_PLACED']);
  });
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

describe('Actions parser', () => {
  test('parses action with core rules', () => {
    const { document } = parse(`
actions:
  CREATE_ITEM:
    state: item
    entity_id_expr: event.item_id
    input:
      item_id: { type: string, required: true }
      title: { type: string, required: true }
    core:
      rules:
        - name: persist_and_emit
          when: {}
          then:
            - op: set
              path: /title
              value: event.title
            - op: emit
              event_type: ITEM_CREATED
              payload:
                item_id: event.item_id
                title: event.title
`);
    const act = document.actions?.CREATE_ITEM;
    expect(act).toBeDefined();
    expect(act!.state).toBe('item');
    expect(act!.entityIdExpr).toBe('event.item_id');
    expect(act!.input?.item_id.type).toBe('string');
    expect(act!.input?.item_id.required).toBe(true);
    expect(act!.core?.rules).toHaveLength(1);
    const rule = act!.core!.rules[0];
    expect(rule.name).toBe('persist_and_emit');
    expect(rule.then).toHaveLength(2);
    expect(rule.then[0].op).toBe('set');
    expect(rule.then[0].path).toBe('/title');
    expect(rule.then[1].op).toBe('emit');
    expect(rule.then[1].eventType).toBe('ITEM_CREATED');
  });

  test('parses preflight with reject', () => {
    const { document } = parse(`
actions:
  AWARD_GOLD:
    state: player
    entity_id_expr: event.player_id
    input:
      player_id: { type: string, required: true }
      amount: { type: integer, required: true }
    preflight:
      rules:
        - name: reject_zero_amount
          when:
            expr: "event.amount <= 0"
          then:
            - op: reject
              code: INVALID_AMOUNT
              message: "Amount must be positive"
    core:
      rules:
        - name: apply_gold
          when: {}
          then:
            - op: add
              path: /inventory/gold
              value: event.amount
`);
    const act = document.actions?.AWARD_GOLD;
    expect(act!.preflight?.rules).toHaveLength(1);
    const preflightRule = act!.preflight!.rules[0];
    expect(preflightRule.when?.raw).toBe('event.amount <= 0');
    expect(preflightRule.then[0].op).toBe('reject');
    expect(preflightRule.then[0].code).toBe('INVALID_AMOUNT');
  });
});

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

describe('Projections parser', () => {
  test('parses projection with source_events, target, derive, mutations', () => {
    const { document } = parse(`
projections:
  order_index:
    source_events:
      - ORDER_PLACED
      - ORDER_CANCELLED
    target:
      table: order_index
      primary_key:
        - order_id
    fields:
      order_id: TEXT
      status: TEXT
      created_at: BIGINT
    derive:
      order_id: event.order_id
      status: event.status
      created_at: event.ts
    mutations:
      ORDER_PLACED:
        op: upsert
      ORDER_CANCELLED:
        op: delete
    indexes:
      - columns: [status]
`);
    const proj = document.projections?.order_index;
    expect(proj).toBeDefined();
    expect(proj!.sourceEvents).toEqual(['ORDER_PLACED', 'ORDER_CANCELLED']);
    expect(proj!.target.table).toBe('order_index');
    expect(proj!.target.primaryKey).toEqual(['order_id']);
    expect(proj!.fields?.order_id).toBe('TEXT');
    expect(proj!.fields?.created_at).toBe('BIGINT');
    expect(proj!.derive?.order_id).toBe('event.order_id');
    expect(proj!.mutations?.ORDER_PLACED.op).toBe('upsert');
    expect(proj!.mutations?.ORDER_CANCELLED.op).toBe('delete');
    expect(proj!.indexes).toHaveLength(1);
    expect(proj!.indexes![0].columns).toEqual(['status']);
  });
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

describe('Queries parser', () => {
  test('parses simple query with where and order_by', () => {
    const { document } = parse(`
queries:
  open_orders_for_customer:
    from: order_index
    input:
      customer_id: { type: string, required: true }
    where:
      customer_id:
        eq: input.customer_id
      status:
        eq: open
    order_by:
      created_at: desc
    limit: 50
`);
    const q = document.queries?.open_orders_for_customer;
    expect(q).toBeDefined();
    expect(q!.from).toBe('order_index');
    expect(q!.limit).toBe(50);
    expect(q!.orderBy?.created_at).toBe('desc');
  });
});

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

describe('Relationships parser', () => {
  test('parses relationship with emit_events', () => {
    const { document } = parse(`
relationships:
  user_follows:
    from: user
    to: user
    cardinality: many_to_many
    unique: true
    emit_events:
      created: USER_FOLLOWED
      removed: USER_UNFOLLOWED
`);
    const rel = document.relationships?.user_follows;
    expect(rel).toBeDefined();
    expect(rel!.from).toBe('user');
    expect(rel!.to).toBe('user');
    expect(rel!.cardinality).toBe('many_to_many');
    expect(rel!.unique).toBe(true);
    expect(rel!.emitEvents?.created).toBe('USER_FOLLOWED');
    expect(rel!.emitEvents?.removed).toBe('USER_UNFOLLOWED');
  });
});

// ---------------------------------------------------------------------------
// Listeners
// ---------------------------------------------------------------------------

describe('Listeners parser', () => {
  test('parses listener on event', () => {
    const { document } = parse(`
listeners:
  - on: RATING_SUBMITTED
    priority: 0
    mutate:
      - op: increment
        field: score_sum
        value: event.score
`);
    expect(document.listeners).toHaveLength(1);
    const l = document.listeners![0];
    expect(l.on).toBe('RATING_SUBMITTED');
    expect(l.priority).toBe(0);
    expect(l.mutate).toHaveLength(1);
    expect(l.mutate[0].op).toBe('increment');
    expect(l.mutate[0].field).toBe('score_sum');
  });
});

// ---------------------------------------------------------------------------
// Error tolerance
// ---------------------------------------------------------------------------

describe('Error tolerance', () => {
  test('returns partial document on invalid YAML with errors', () => {
    const { document } = parse(`
state:
  player:
    entity_key: player_id
    fields: {not_valid: yaml: structure
`);
    // Should not throw; document may have errors but still returns
    expect(document).toBeDefined();
  });

  test('parses empty document without crashing', () => {
    const { document } = parse('');
    expect(document).toBeDefined();
    expect(document.errors).toBeDefined();
  });

  test('handles file with only comments', () => {
    const { document } = parse('# This is just a comment\n# Nothing here\n');
    expect(document).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Symbol extraction
// ---------------------------------------------------------------------------

describe('Symbol extraction', () => {
  const FULL_DOC = `
state:
  order:
    entity_key: order_id
    fields:
      - name: status
        type: string
        default: ""

events:
  ORDER_PLACED:
    state: order
    entity_expr: event.order_id
    payload:
      order_id: string

actions:
  PLACE_ORDER:
    state: order
    entity_id_expr: event.order_id
    input:
      order_id: { type: string, required: true }
    core:
      rules:
        - name: place
          when: {}
          then:
            - op: emit
              event_type: ORDER_PLACED
              payload:
                order_id: event.order_id

projections:
  order_detail:
    source_events: [ORDER_PLACED]
    target:
      table: order_detail
      primary_key: [order_id]
    fields:
      order_id: TEXT
    derive:
      order_id: event.order_id
    mutations:
      ORDER_PLACED:
        op: upsert

queries:
  get_order:
    from: order_detail
    input:
      order_id: { type: string, required: true }
    where:
      order_id:
        eq: input.order_id
    limit: 1
`;

  test('extracts all symbol kinds', () => {
    const { symbols } = parse(FULL_DOC);
    const kinds = new Set(symbols.map((s) => s.kind));
    expect(kinds.has('entity')).toBe(true);
    expect(kinds.has('event')).toBe(true);
    expect(kinds.has('action')).toBe(true);
    expect(kinds.has('projection')).toBe(true);
    expect(kinds.has('query')).toBe(true);
  });

});

// ---------------------------------------------------------------------------
// AI decisions (prompts, decisions, memories)
// ---------------------------------------------------------------------------

describe('AI decisions parser', () => {
  test('parses prompts, decisions, memories, and decision op', () => {
    const { document, symbols } = parse(`
dsl_version: 1
app: demo

state:
  comment:
    entity_key: comment_id
    fields:
      - name: body
        type: string
        default: ""

events:
  COMMENT_MODERATED:
    state: comment
    entity_expr: event.comment_id
    payload:
      comment_id: string
      allowed: boolean

prompts:
  moderation_v1:
    instructions: |
      Comment: {{ comment }}

decisions:
  moderate_comment:
    executor: mock
    model: mock-model
    prompt: moderation_v1
    emits: COMMENT_MODERATED
    input:
      comment_id:
        type: string
        required: true
      comment:
        type: string
        required: true
    output:
      allowed:
        type: boolean
        required: true

memories:
  customer_memory:
    source_events:
      - ORDER_CREATED
    partition_by: customer_id
    embedding:
      executor: openai
      model: text-embedding-3-small
    content: |
      Event: {{ event.type }}

actions:
  CREATE_COMMENT:
    state: comment
    side_effects:
      rules:
        - name: moderate
          then:
            - op: decision
              ref: moderate_comment
              input:
                comment_id: event.comment_id
                comment: event.body
`);
    expect(document.prompts?.moderation_v1.instructions).toContain('{{ comment }}');
    expect(document.decisions?.moderate_comment.emits).toBe('COMMENT_MODERATED');
    expect(document.decisions?.moderate_comment.input?.comment_id.required).toBe(true);
    expect(document.memories?.customer_memory.partitionBy).toBe('customer_id');
    expect(document.actions?.CREATE_COMMENT.sideEffects?.rules[0].then[0].op).toBe('decision');
    expect(document.actions?.CREATE_COMMENT.sideEffects?.rules[0].then[0].ref).toBe('moderate_comment');
    expect(symbols.some((s) => s.kind === 'prompt' && s.name === 'moderation_v1')).toBe(true);
    expect(symbols.some((s) => s.kind === 'decision' && s.name === 'moderate_comment')).toBe(true);
    expect(symbols.some((s) => s.kind === 'memory' && s.name === 'customer_memory')).toBe(true);
  });

  test('parses providers and provider references on decisions/memories', () => {
    const { document, symbols } = parse(`
providers:
  reasoning:
    executor: openai
    model: gpt-4o-mini
  embeddings:
    executor: openai
    model: text-embedding-3-small

decisions:
  triage:
    provider: reasoning
    prompt: triage_v1
    emits: DONE
    input:
      body: { type: string, required: true }
    output:
      ok: { type: boolean, required: true }

memories:
  history:
    source_events: [NOTE]
    partition_by: customer_id
    embedding:
      provider: embeddings
    content: "{{ event.note }}"
`);
    expect(document.providers?.reasoning.executor).toBe('openai');
    expect(document.decisions?.triage.provider).toBe('reasoning');
    expect(document.memories?.history.embedding?.provider).toBe('embeddings');
    expect(symbols.some((s) => s.kind === 'provider' && s.name === 'reasoning')).toBe(true);
  });
});
