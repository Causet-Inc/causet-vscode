/**
 * Unit tests for the WorkspaceIndex.
 */

import { WorkspaceIndex } from 'causet-shared';

const EVENTS_DOC = `
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
`;

const PROJECTIONS_DOC = `
projections:
  order_index:
    source_events: [ORDER_PLACED, ORDER_CANCELLED]
    target:
      table: order_index
      primary_key: [order_id]
    fields:
      order_id: TEXT
    derive:
      order_id: event.order_id
    mutations:
      ORDER_PLACED:
        op: upsert
      ORDER_CANCELLED:
        op: delete
`;

const QUERIES_DOC = `
queries:
  get_order:
    from: order_index
    input:
      order_id: { type: string, required: true }
    where:
      order_id:
        eq: input.order_id
    limit: 1
`;

describe('WorkspaceIndex', () => {
  let index: WorkspaceIndex;

  beforeEach(() => {
    index = new WorkspaceIndex();
    index.update('file:///events.causet', EVENTS_DOC);
    index.update('file:///projections.causet', PROJECTIONS_DOC);
    index.update('file:///queries.causet', QUERIES_DOC);
  });

  test('indexes multiple files and reports correct size', () => {
    expect(index.size).toBe(3);
  });

  test('resolves events by name', () => {
    const ev = index.resolveEvent('ORDER_PLACED');
    expect(ev).toBeDefined();
    expect(ev!.def.name).toBe('ORDER_PLACED');
    expect(ev!.uri).toBe('file:///events.causet');
  });

  test('resolves projections by name', () => {
    const proj = index.resolveProjection('order_index');
    expect(proj).toBeDefined();
    expect(proj!.def.target.table).toBe('order_index');
  });

  test('resolves queries by name', () => {
    const q = index.resolveQuery('get_order');
    expect(q).toBeDefined();
    expect(q!.def.from).toBe('order_index');
  });

  test('allEventNames returns all event names', () => {
    const names = index.allEventNames();
    expect(names).toContain('ORDER_PLACED');
    expect(names).toContain('ORDER_CANCELLED');
  });

  test('allProjectionNames returns all projection names', () => {
    const names = index.allProjectionNames();
    expect(names).toContain('order_index');
  });

  test('allQueryNames returns all query names', () => {
    const names = index.allQueryNames();
    expect(names).toContain('get_order');
  });

  test('searchSymbols finds by name substring', () => {
    const results = index.searchSymbols('ORDER');
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.name.includes('ORDER') || r.name.toLowerCase().includes('order'))).toBe(true);
  });

  test('findReferences returns all occurrences of a symbol', () => {
    const refs = index.findReferences('ORDER_PLACED');
    // Should appear in events.causet (definition), projections.causet (source_events, mutations)
    expect(refs.length).toBeGreaterThan(1);
    const uris = new Set(refs.map((r) => r.uri));
    expect(uris.has('file:///events.causet')).toBe(true);
    expect(uris.has('file:///projections.causet')).toBe(true);
  });

  test('remove() cleans up a document from the index', () => {
    index.remove('file:///queries.causet');
    expect(index.size).toBe(2);
    expect(index.resolveQuery('get_order')).toBeUndefined();
  });

  test('update() replaces a document', () => {
    index.update('file:///events.causet', `
events:
  NEW_EVENT:
    state: thing
    entity_expr: event.thing_id
    payload:
      thing_id: string
`);
    expect(index.resolveEvent('ORDER_PLACED')).toBeUndefined();
    expect(index.resolveEvent('NEW_EVENT')).toBeDefined();
  });
});
