/**
 * Unit tests for the Causet diagnostics provider.
 */

import { parseCausetDocument, WorkspaceIndex } from 'causet-shared';
import { provideDiagnostics } from '../language-server/src/providers/diagnostics.js';
import { DiagnosticSeverity } from 'vscode-languageserver/node.js';

function diagnose(text: string) {
  const index = new WorkspaceIndex();
  const result = index.update('file:///test.causet', text);
  return provideDiagnostics(result.document, index);
}

// ---------------------------------------------------------------------------
// State diagnostics
// ---------------------------------------------------------------------------

describe('State diagnostics', () => {
  test('warns when entity_key is missing', () => {
    const diags = diagnose(`
state:
  player:
    fields:
      - name: name
        type: string
        default: ""
`);
    expect(diags.some((d) => d.code === 'CAUSET_MISSING_ENTITY_KEY')).toBe(true);
  });

  test('errors on duplicate fields', () => {
    const diags = diagnose(`
state:
  player:
    entity_key: player_id
    fields:
      - name: status
        type: string
        default: ""
      - name: status
        type: string
        default: ""
`);
    expect(diags.some((d) => d.code === 'CAUSET_DUPLICATE_FIELD')).toBe(true);
  });

  test('warns on missing array default', () => {
    const diags = diagnose(`
state:
  player:
    entity_key: player_id
    fields:
      - name: items
        type: array
        item_type: string
`);
    expect(diags.some((d) => d.code === 'CAUSET_MISSING_DEFAULT')).toBe(true);
  });

  test('does not warn when array default is empty list', () => {
    const diags = diagnose(`
state:
  wallet:
    entity_key: wallet_id
    fields:
      - name: pending_envelopes
        type: array
        item_type: object
        default: []
`);
    expect(diags.some((d) => d.code === 'CAUSET_MISSING_DEFAULT')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Event diagnostics
// ---------------------------------------------------------------------------

describe('Event diagnostics', () => {
  test('warns when event references unknown entity', () => {
    const diags = diagnose(`
events:
  ORDER_PLACED:
    state: nonexistent_entity
    entity_expr: event.order_id
    payload:
      order_id: string
`);
    expect(diags.some((d) => d.code === 'CAUSET_UNKNOWN_ENTITY')).toBe(true);
  });

  test('resolves entity defined in another workspace file', () => {
    const index = new WorkspaceIndex();
    index.update('file:///states/wallet.state.causet', `
state:
  show:
    entity_key: show_id
    fields:
      - name: title
        type: string
        default: ""
  player:
    entity_key: player_id
    fields:
      - name: inventory/gold
        type: int
        default: 0
`);
    const eventsDoc = index.update('file:///events/show.events.causet', `
events:
  SHOW_PUBLISHED:
    state: show
    entity_expr: event.show_id
    payload:
      show_id: string
`).document;

    const diags = provideDiagnostics(eventsDoc, index);
    expect(diags.some((d) => d.code === 'CAUSET_UNKNOWN_ENTITY')).toBe(false);
  });

  test('errors on reserved payload field "type"', () => {
    const diags = diagnose(`
events:
  NOTIFICATION_SENT:
    state: notification
    entity_expr: event.notification_id
    payload:
      notification_id: string
      type: string
`);
    expect(diags.some((d) => d.code === 'CAUSET_RESERVED_PAYLOAD_FIELD')).toBe(true);
  });

  test('errors on reserved payload field "ts"', () => {
    const diags = diagnose(`
events:
  ITEM_CREATED:
    state: item
    entity_expr: event.item_id
    payload:
      item_id: string
      ts: number
`);
    expect(diags.some((d) => d.code === 'CAUSET_RESERVED_PAYLOAD_FIELD')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Action diagnostics
// ---------------------------------------------------------------------------

describe('Action diagnostics', () => {
  test('warns when emit references unknown event', () => {
    const diags = diagnose(`
actions:
  CREATE_ITEM:
    state: item
    entity_id_expr: event.item_id
    input:
      item_id: { type: string, required: true }
    core:
      rules:
        - name: create
          when: {}
          then:
            - op: emit
              event_type: NONEXISTENT_EVENT
              payload:
                item_id: event.item_id
`);
    expect(diags.some((d) => d.code === 'CAUSET_UNKNOWN_EVENT_TYPE')).toBe(true);
  });

  test('errors on unknown op', () => {
    const diags = diagnose(`
state:
  player:
    entity_key: player_id
    fields: []
events:
  GOLD_AWARDED:
    state: player
    entity_expr: event.player_id
    payload:
      player_id: string
actions:
  AWARD_GOLD:
    state: player
    entity_id_expr: event.player_id
    input:
      player_id: { type: string, required: true }
    core:
      rules:
        - name: award
          when: {}
          then:
            - op: fly_to_the_moon
              path: /inventory/gold
              value: 100
`);
    expect(diags.some((d) => d.code === 'CAUSET_OP_UNKNOWN')).toBe(true);
  });

  test('warns when reject is outside preflight', () => {
    const diags = diagnose(`
actions:
  DO_THING:
    state: thing
    entity_id_expr: event.thing_id
    input:
      thing_id: { type: string, required: true }
    core:
      rules:
        - name: bad_reject
          when: {}
          then:
            - op: reject
              code: SOME_CODE
`);
    expect(diags.some((d) => d.code === 'CAUSET_REJECT_OUTSIDE_PREFLIGHT')).toBe(true);
  });

  test('errors on non-deterministic function in expression', () => {
    const diags = diagnose(`
actions:
  CREATE_THING:
    state: thing
    entity_id_expr: event.thing_id
    input:
      thing_id: { type: string, required: true }
    core:
      rules:
        - name: bad_expr
          when:
            expr: "now() > entity.created_at"
          then:
            - op: set
              path: /updated
              value: "true"
`);
    expect(diags.some((d) => d.code === 'CAUSET_NON_DETERMINISTIC')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Projection diagnostics
// ---------------------------------------------------------------------------

describe('Projection diagnostics', () => {
  test('errors when source_event not registered', () => {
    const diags = diagnose(`
projections:
  order_index:
    source_events:
      - NONEXISTENT_EVENT
    target:
      table: order_index
      primary_key: [order_id]
    fields:
      order_id: TEXT
    derive:
      order_id: event.order_id
    mutations:
      NONEXISTENT_EVENT:
        op: upsert
`);
    expect(diags.some((d) => d.code === 'CAUSET_UNKNOWN_SOURCE_EVENT')).toBe(true);
  });

  test('errors when primary_key is missing', () => {
    const diags = diagnose(`
projections:
  thing_index:
    source_events: []
    target:
      table: thing_index
    fields:
      id: TEXT
    derive:
      id: event.id
    mutations:
      THING_CREATED:
        op: upsert
`);
    expect(diags.some((d) => d.code === 'CAUSET_MISSING_PRIMARY_KEY')).toBe(true);
  });

  test('errors when neither mutations nor aggregates present', () => {
    const diags = diagnose(`
events:
  THING_CREATED:
    state: thing
    entity_expr: event.thing_id
    payload:
      thing_id: string

projections:
  thing_detail:
    source_events: [THING_CREATED]
    target:
      table: thing_detail
      primary_key: [thing_id]
    fields:
      thing_id: TEXT
    derive:
      thing_id: event.thing_id
`);
    expect(diags.some((d) => d.code === 'CAUSET_PROJECTION_NO_WRITE_OP')).toBe(true);
  });

  test('warns when PK column is not in derive', () => {
    const diags = diagnose(`
events:
  THING_CREATED:
    state: thing
    entity_expr: event.thing_id
    payload:
      thing_id: string

projections:
  thing_detail:
    source_events: [THING_CREATED]
    target:
      table: thing_detail
      primary_key: [thing_id, missing_key]
    fields:
      thing_id: TEXT
    derive:
      thing_id: event.thing_id
    mutations:
      THING_CREATED:
        op: upsert
`);
    expect(diags.some((d) => d.code === 'CAUSET_PK_NOT_DERIVED')).toBe(true);
  });

  test('informs when fields block is missing', () => {
    const diags = diagnose(`
events:
  X:
    state: x
    entity_expr: event.x_id
    payload:
      x_id: string
projections:
  x_view:
    source_events: [X]
    target:
      table: x_view
      primary_key: [x_id]
    derive:
      x_id: event.x_id
    mutations:
      X:
        op: upsert
`);
    expect(diags.some((d) => d.code === 'CAUSET_MISSING_FIELDS_BLOCK')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Query diagnostics
// ---------------------------------------------------------------------------

describe('Query diagnostics', () => {
  test('warns on unknown projection in from:', () => {
    const diags = diagnose(`
queries:
  get_items:
    from: nonexistent_projection
    limit: 10
`);
    expect(diags.some((d) => d.code === 'CAUSET_UNKNOWN_PROJECTION')).toBe(true);
  });

  test('warns on group_by without aggregate', () => {
    const diags = diagnose(`
events:
  X:
    state: x
    entity_expr: event.x_id
    payload:
      x_id: string
projections:
  x_counts:
    source_events: [X]
    target:
      table: x_counts
      primary_key: [owner_id]
    fields:
      owner_id: TEXT
    derive:
      owner_id: event.owner_id
    mutations:
      X:
        op: upsert
queries:
  count_items:
    from: x_counts
    group_by:
      - owner_id
    limit: 1
`);
    expect(diags.some((d) => d.code === 'CAUSET_GROUP_BY_NO_AGGREGATE')).toBe(true);
  });
});
