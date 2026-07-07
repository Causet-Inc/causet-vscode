/**
 * Causet DSL parser.
 *
 * Strategy:
 *  1. Use the `yaml` package (Eemeli Aro) to parse the YAML CST, preserving
 *     exact line/column offsets for every key and value.
 *  2. Walk the parsed document and build a typed CausetDocument.
 *  3. Every semantic node carries a `range` referencing the source text so
 *     providers (hover, go-to-def, rename, …) always work with real positions.
 *
 * The parser is intentionally tolerant of structural errors – partial documents
 * are indexed so that completion and hover still work while you type.
 */

import * as YAML from 'yaml';
import type {
  CausetDocument,
  EntityDefinition,
  EventDefinition,
  ActionDefinition,
  ProjectionDefinition,
  QueryDefinition,
  RelationshipDefinition,
  ListenerDefinition,
  SagaDefinition,
  ResourceDefinition,
  IncludesSection,
  RulePhase,
  Rule,
  Operation,
  FieldDefinition,
  InputField,
  ProjectionTarget,
  MutationSpec,
  AggregateSpec,
  IndexSpec,
  JoinSpec,
  Range,
  Position,
  ParseError,
  FieldType,
  SqlType,
  WorkspaceSymbol,
  CommitEnvelopeDefinition,
  CommitEnvelopeParticipant,
  SagaStep,
  PromptDefinition,
  DecisionDefinition,
  DecisionSchemaField,
  MemoryDefinition,
  ProviderDefinition,
} from './ast.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function zeroRange(): Range {
  return { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
}

function posFromOffset(text: string, offset: number): Position {
  if (offset == null || offset < 0) return { line: 0, character: 0 };
  let line = 0;
  let lastNl = -1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') { line++; lastNl = i; }
  }
  return { line, character: offset - lastNl - 1 };
}

function rangeOf(node: YAML.Node | null | undefined, text: string): Range {
  if (!node) return zeroRange();
  const start = posFromOffset(text, (node as any).range?.[0] ?? 0);
  const end = posFromOffset(text, (node as any).range?.[1] ?? 0);
  return { start, end };
}

function rangeOfPair(pair: YAML.Pair, text: string): Range {
  return rangeOf(pair.key as YAML.Node, text);
}

function scalarValue(node: unknown): string | number | boolean | null | undefined {
  if (node instanceof YAML.Scalar) return node.value as string | number | boolean | null;
  return undefined;
}

/** Parse YAML scalar, sequence, or mapping into a JS value (for default:, set:, etc.) */
function yamlValue(node: unknown): unknown {
  if (node == null) return undefined;
  if (node instanceof YAML.Scalar) return node.value;
  if (node instanceof YAML.YAMLSeq) {
    return node.items.map((item) => yamlValue(item));
  }
  if (node instanceof YAML.YAMLMap) {
    const obj: Record<string, unknown> = {};
    for (const pair of node.items as YAML.Pair[]) {
      const k = str(pair.key);
      if (k) obj[k] = yamlValue(pair.value);
    }
    return obj;
  }
  return undefined;
}

function mapNode(node: unknown): YAML.YAMLMap | null {
  if (node instanceof YAML.YAMLMap) return node;
  return null;
}

function seqNode(node: unknown): YAML.YAMLSeq | null {
  if (node instanceof YAML.YAMLSeq) return node;
  return null;
}

function getKey(map: YAML.YAMLMap, key: string): unknown {
  const pair = map.items.find(
    (p) => p instanceof YAML.Pair && scalarValue(p.key) === key,
  ) as YAML.Pair | undefined;
  return pair?.value;
}

function getKeyNode(map: YAML.YAMLMap, key: string): YAML.Pair | undefined {
  return map.items.find(
    (p) => p instanceof YAML.Pair && scalarValue(p.key) === key,
  ) as YAML.Pair | undefined;
}

function str(node: unknown): string | undefined {
  const v = scalarValue(node);
  return v != null ? String(v) : undefined;
}

function num(node: unknown): number | undefined {
  const v = scalarValue(node);
  return typeof v === 'number' ? v : undefined;
}

function bool(node: unknown): boolean | undefined {
  const v = scalarValue(node);
  return typeof v === 'boolean' ? v : undefined;
}

function strSeq(node: unknown): string[] {
  const seq = seqNode(node);
  if (!seq) {
    const s = str(node);
    if (s) return [s];
    return [];
  }
  return seq.items.map((i) => str(i)).filter(Boolean) as string[];
}

// ---------------------------------------------------------------------------
// Field / input parsers
// ---------------------------------------------------------------------------

function parseFieldEntry(name: string, node: unknown, text: string, range: Range): FieldDefinition {
  const def: FieldDefinition = { kind: 'field', name, range };
  if (!node) return def;

  // Inline short-form: `field_name: string`
  const scalar = scalarValue(node);
  if (scalar != null) {
    def.type = String(scalar) as FieldType;
    def.valueRange = rangeOf(node as YAML.Node, text);
    return def;
  }

  const m = mapNode(node);
  if (!m) return def;
  def.valueRange = rangeOf(m, text);
  def.type = str(getKey(m, 'type')) as FieldType | undefined;
  def.itemType = str(getKey(m, 'item_type')) as FieldType | undefined;
  def.required = bool(getKey(m, 'required'));
  def.description = str(getKey(m, 'description'));
  const defVal = getKey(m, 'default');
  const parsedDefault = yamlValue(defVal);
  if (parsedDefault !== undefined) {
    def.default = parsedDefault;
  }

  const itemFieldsNode = mapNode(getKey(m, 'item_fields'));
  if (itemFieldsNode) {
    def.itemFields = {};
    for (const pair of itemFieldsNode.items as YAML.Pair[]) {
      const fn = str(pair.key);
      if (!fn) continue;
      const fr = rangeOfPair(pair, text);
      def.itemFields[fn] = parseFieldEntry(fn, pair.value, text, fr);
    }
  }
  return def;
}

function parseInputFields(node: unknown, text: string): Record<string, InputField> {
  const result: Record<string, InputField> = {};
  const m = mapNode(node);
  if (!m) return result;
  for (const pair of m.items as YAML.Pair[]) {
    const name = str(pair.key);
    if (!name) continue;
    const r = rangeOfPair(pair, text);
    const input: InputField = { kind: 'inputField', name, range: r };
    const vm = mapNode(pair.value);
    if (vm) {
      input.type = str(getKey(vm, 'type')) as FieldType | undefined;
      input.required = bool(getKey(vm, 'required'));
      input.description = str(getKey(vm, 'description'));
    } else {
      const s = str(pair.value);
      if (s) input.type = s as FieldType;
    }
    result[name] = input;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Operation parser
// ---------------------------------------------------------------------------

function parseOperation(node: unknown, text: string): Operation | null {
  const m = mapNode(node);
  if (!m) return null;
  const r = rangeOf(m, text);
  const op = str(getKey(m, 'op'));
  if (!op) return null;

  const o: Operation = { kind: 'operation', op: op as any, range: r };
  o.path = str(getKey(m, 'path'));
  const valNode = getKey(m, 'value');
  o.value = scalarValue(valNode) ?? str(valNode);
  o.eventType = str(getKey(m, 'event_type'));
  o.targetStream = str(getKey(m, 'target_stream'));
  o.targetEntity = str(getKey(m, 'target_entity'));
  o.intentType = str(getKey(m, 'intent_type'));
  o.code = str(getKey(m, 'code'));
  o.message = str(getKey(m, 'message'));
  o.into = str(getKey(m, 'into'));
  o.as = str(getKey(m, 'as'));
  o.from = str(getKey(m, 'from'));
  o.relationship = str(getKey(m, 'relationship'));
  o.toId = str(getKey(m, 'to_id'));
  o.ref = str(getKey(m, 'ref'));

  const inputNode = mapNode(getKey(m, 'input'));
  if (inputNode) {
    o.input = {};
    for (const p of inputNode.items as YAML.Pair[]) {
      const k = str(p.key);
      if (k) o.input[k] = scalarValue(p.value) ?? str(p.value) ?? null;
    }
  }

  const payloadNode = mapNode(getKey(m, 'payload'));
  if (payloadNode) {
    o.payload = {};
    for (const p of payloadNode.items as YAML.Pair[]) {
      const k = str(p.key);
      if (k) o.payload[k] = scalarValue(p.value) ?? str(p.value) ?? null;
    }
  }

  const thenNode = seqNode(getKey(m, 'then'));
  if (thenNode) {
    o.then = thenNode.items
      .map((i) => parseOperation(i, text))
      .filter(Boolean) as Operation[];
  }
  const elseNode = seqNode(getKey(m, 'else'));
  if (elseNode) {
    o.else = elseNode.items
      .map((i) => parseOperation(i, text))
      .filter(Boolean) as Operation[];
  }
  return o;
}

function parseRulePhase(node: unknown, text: string): RulePhase | undefined {
  const m = mapNode(node);
  if (!m) return undefined;
  const r = rangeOf(m, text);
  const rulesNode = seqNode(getKey(m, 'rules'));
  if (!rulesNode) return { kind: 'rulePhase', range: r, rules: [] };

  const rules: Rule[] = [];
  for (const ruleNode of rulesNode.items) {
    const rm = mapNode(ruleNode);
    if (!rm) continue;
    const rr = rangeOf(rm, text);
    const name = str(getKey(rm, 'name')) ?? '<unnamed>';
    const whenNode = getKey(rm, 'when');
    let when = undefined;
    if (whenNode != null) {
      const ws = str(whenNode);
      const wm = mapNode(whenNode);
      if (ws) {
        when = { kind: 'expression' as const, raw: ws, range: rangeOf(whenNode as YAML.Node, text) };
      } else if (wm) {
        const expr = str(getKey(wm, 'expr'));
        when = expr
          ? { kind: 'expression' as const, raw: expr, range: rangeOf(wm, text) }
          : null;
      }
    }
    const thenSeq = seqNode(getKey(rm, 'then'));
    const ops: Operation[] = thenSeq
      ? (thenSeq.items.map((i) => parseOperation(i, text)).filter(Boolean) as Operation[])
      : [];

    rules.push({ kind: 'rule', name, when, then: ops, range: rr });
  }
  return { kind: 'rulePhase', range: r, rules };
}

// ---------------------------------------------------------------------------
// Section parsers
// ---------------------------------------------------------------------------

function parseState(mapNode_: YAML.YAMLMap, text: string): Record<string, EntityDefinition> {
  const result: Record<string, EntityDefinition> = {};
  for (const pair of mapNode_.items as YAML.Pair[]) {
    const name = str(pair.key);
    if (!name) continue;
    const r = rangeOfPair(pair, text);
    const vm = mapNode(pair.value);
    const entity: EntityDefinition = { kind: 'entity', name, range: r, fields: [] };
    if (vm) {
      entity.entityKey = str(getKey(vm, 'entity_key'));
      entity.description = str(getKey(vm, 'description'));
      const fieldsNode = seqNode(getKey(vm, 'fields'));
      if (fieldsNode) {
        for (const f of fieldsNode.items) {
          const fm = mapNode(f);
          if (!fm) continue;
          const fn = str(getKey(fm, 'name'));
          if (!fn) continue;
          const fr = rangeOf(fm, text);
          entity.fields.push(parseFieldEntry(fn, fm, text, fr));
        }
      }
      // Also accept map-style fields
      const fieldsMapNode = mapNode(getKey(vm, 'fields'));
      if (fieldsMapNode) {
        for (const fp of fieldsMapNode.items as YAML.Pair[]) {
          const fn = str(fp.key);
          if (!fn) continue;
          const fr = rangeOfPair(fp, text);
          entity.fields.push(parseFieldEntry(fn, fp.value, text, fr));
        }
      }
    }
    result[name] = entity;
  }
  return result;
}

function parseEvents(m: YAML.YAMLMap, text: string): Record<string, EventDefinition> {
  const result: Record<string, EventDefinition> = {};
  for (const pair of m.items as YAML.Pair[]) {
    const name = str(pair.key);
    if (!name) continue;
    const r = rangeOfPair(pair, text);
    const vm = mapNode(pair.value);
    const ev: EventDefinition = { kind: 'event', name, range: r };
    if (vm) {
      ev.state = str(getKey(vm, 'state'));
      ev.entityExpr = str(getKey(vm, 'entity_expr'));
      ev.eventKind = str(getKey(vm, 'kind')) as any;
      const payloadNode = mapNode(getKey(vm, 'payload'));
      if (payloadNode) {
        ev.payload = {};
        for (const pp of payloadNode.items as YAML.Pair[]) {
          const k = str(pp.key);
          if (!k) continue;
          const pv = str(pp.value);
          if (pv) {
            ev.payload[k] = pv;
          } else {
            const pvm = mapNode(pp.value);
            if (pvm) {
              ev.payload[k] = parseFieldEntry(k, pvm, text, rangeOfPair(pp, text));
            }
          }
        }
      }
    }
    result[name] = ev;
  }
  return result;
}

function parseActions(m: YAML.YAMLMap, text: string): Record<string, ActionDefinition> {
  const result: Record<string, ActionDefinition> = {};
  for (const pair of m.items as YAML.Pair[]) {
    const name = str(pair.key);
    if (!name) continue;
    const r = rangeOfPair(pair, text);
    const vm = mapNode(pair.value);
    const action: ActionDefinition = { kind: 'action', name, range: r };
    if (vm) {
      action.state = str(getKey(vm, 'state'));
      action.entityIdExpr = str(getKey(vm, 'entity_id_expr'));
      action.description = str(getKey(vm, 'description'));
      const inputNode = getKey(vm, 'input');
      if (inputNode) action.input = parseInputFields(inputNode, text);
      action.preflight = parseRulePhase(getKey(vm, 'preflight'), text);
      action.core = parseRulePhase(getKey(vm, 'core'), text);
      action.sideEffects = parseRulePhase(getKey(vm, 'side_effects') ?? getKey(vm, 'side_effect'), text);
    }
    result[name] = action;
  }
  return result;
}

function parseProjectionTarget(node: unknown, text: string): ProjectionTarget {
  const m = mapNode(node);
  if (!m) return { table: '', primaryKey: [], range: zeroRange() };
  const r = rangeOf(m, text);
  return {
    range: r,
    table: str(getKey(m, 'table')) ?? '',
    primaryKey: strSeq(getKey(m, 'primary_key')),
    entityKey: str(getKey(m, 'entity_key')),
    entityExpr: str(getKey(m, 'entity_expr')),
  };
}

function parseMutations(node: unknown, text: string): Record<string, MutationSpec> {
  const result: Record<string, MutationSpec> = {};
  const m = mapNode(node);
  if (!m) return result;
  for (const pair of m.items as YAML.Pair[]) {
    const evName = str(pair.key);
    if (!evName) continue;
    const r = rangeOfPair(pair, text);
    const vm = mapNode(pair.value);
    const op = vm ? (str(getKey(vm, 'op')) ?? 'upsert') : str(pair.value) ?? 'upsert';
    result[evName] = { range: r, op: op as any };
  }
  return result;
}

function parseAggregates(
  node: unknown,
  text: string,
): Record<string, Record<string, AggregateSpec>> {
  const result: Record<string, Record<string, AggregateSpec>> = {};
  const m = mapNode(node);
  if (!m) return result;
  for (const pair of m.items as YAML.Pair[]) {
    const evName = str(pair.key);
    if (!evName) continue;
    const vm = mapNode(pair.value);
    if (!vm) continue;
    result[evName] = {};
    for (const fp of vm.items as YAML.Pair[]) {
      const field = str(fp.key);
      if (!field) continue;
      const fm = mapNode(fp.value);
      const aggSpec: AggregateSpec = {
        range: rangeOfPair(fp, text),
        op: fm ? (str(getKey(fm, 'op')) as any) ?? 'add' : 'add',
        by: fm ? (num(getKey(fm, 'by')) ?? str(getKey(fm, 'by'))) : undefined,
        floor: fm ? num(getKey(fm, 'floor')) : undefined,
      };
      result[evName][field] = aggSpec;
    }
  }
  return result;
}

function parseIndexes(node: unknown, text: string): IndexSpec[] {
  const seq = seqNode(node);
  if (!seq) return [];
  return seq.items.map((i) => {
    const m = mapNode(i);
    if (!m) return null;
    const r = rangeOf(m, text);
    return {
      range: r,
      columns: strSeq(getKey(m, 'columns')),
      direction: str(getKey(m, 'direction')) as any,
      unique: bool(getKey(m, 'unique')),
    } as IndexSpec;
  }).filter(Boolean) as IndexSpec[];
}

function parseProjections(m: YAML.YAMLMap, text: string): Record<string, ProjectionDefinition> {
  const result: Record<string, ProjectionDefinition> = {};
  for (const pair of m.items as YAML.Pair[]) {
    const name = str(pair.key);
    if (!name) continue;
    const r = rangeOfPair(pair, text);
    const vm = mapNode(pair.value);
    const proj: ProjectionDefinition = {
      kind: 'projection', name, range: r,
      sourceEvents: [],
      target: { table: '', primaryKey: [], range: r },
    };
    if (vm) {
      proj.sourceEvents = strSeq(getKey(vm, 'source_events'));
      proj.target = parseProjectionTarget(getKey(vm, 'target'), text);
      proj.mutations = parseMutations(getKey(vm, 'mutations'), text);
      proj.aggregates = parseAggregates(getKey(vm, 'aggregates'), text);
      proj.indexes = parseIndexes(getKey(vm, 'indexes'), text);

      // derive block
      const deriveNode = mapNode(getKey(vm, 'derive'));
      if (deriveNode) {
        proj.derive = {};
        for (const dp of deriveNode.items as YAML.Pair[]) {
          const k = str(dp.key);
          if (k) proj.derive[k] = str(dp.value) ?? '';
        }
      }

      // fields block
      const fieldsNode = mapNode(getKey(vm, 'fields'));
      if (fieldsNode) {
        proj.fields = {};
        for (const fp of fieldsNode.items as YAML.Pair[]) {
          const k = str(fp.key);
          if (k) proj.fields[k] = str(fp.value) as SqlType ?? 'TEXT';
        }
      }

      proj.description = str(getKey(vm, 'description'));

      // bucket
      const bucketNode = mapNode(getKey(vm, 'bucket'));
      if (bucketNode) {
        proj.bucket = {
          field: str(getKey(bucketNode, 'field')) ?? '',
          interval: str(getKey(bucketNode, 'interval')) ?? '1h',
        };
      }

      // partition
      const partitionNode = mapNode(getKey(vm, 'partition'));
      if (partitionNode) {
        proj.partition = {
          range: rangeOf(partitionNode, text),
          strategy: str(getKey(partitionNode, 'strategy')) as any ?? 'range',
          field: str(getKey(partitionNode, 'field')),
          interval: str(getKey(partitionNode, 'interval')),
          partitions: num(getKey(partitionNode, 'partitions')),
          precreate: num(getKey(partitionNode, 'precreate')),
          retention: str(getKey(partitionNode, 'retention')),
          defaultPartition: bool(getKey(partitionNode, 'default_partition')),
        };
      }
    }
    result[name] = proj;
  }
  return result;
}

function parseQueries(m: YAML.YAMLMap, text: string): Record<string, QueryDefinition> {
  const result: Record<string, QueryDefinition> = {};
  for (const pair of m.items as YAML.Pair[]) {
    const name = str(pair.key);
    if (!name) continue;
    const r = rangeOfPair(pair, text);
    const vm = mapNode(pair.value);
    const q: QueryDefinition = { kind: 'query', name, range: r, from: '' };
    if (vm) {
      q.from = str(getKey(vm, 'from')) ?? '';
      q.limit = num(getKey(vm, 'limit'));
      q.distinct = bool(getKey(vm, 'distinct'));
      q.fields = strSeq(getKey(vm, 'fields'));
      q.groupBy = strSeq(getKey(vm, 'group_by'));
      q.coalesceZero = strSeq(getKey(vm, 'coalesce_zero'));

      const inputNode = getKey(vm, 'input');
      if (inputNode) q.input = parseInputFields(inputNode, text);

      const whereNode = mapNode(getKey(vm, 'where'));
      if (whereNode) {
        q.where = {};
        for (const wp of whereNode.items as YAML.Pair[]) {
          const field = str(wp.key);
          if (!field) continue;
          const wvm = mapNode(wp.value);
          if (wvm) {
            const clause: Partial<Record<string, unknown>> = {};
            for (const op of wvm.items as YAML.Pair[]) {
              const opName = str(op.key);
              if (opName) clause[opName] = scalarValue(op.value) ?? str(op.value);
            }
            q.where[field] = clause as any;
          }
        }
      }

      const orderByNode = mapNode(getKey(vm, 'order_by'));
      if (orderByNode) {
        q.orderBy = {};
        for (const op of orderByNode.items as YAML.Pair[]) {
          const k = str(op.key);
          if (k) q.orderBy[k] = (str(op.value) as 'asc' | 'desc') ?? 'asc';
        }
      }

      const joinsNode = mapNode(getKey(vm, 'joins'));
      if (joinsNode) {
        q.joins = {};
        for (const jp of joinsNode.items as YAML.Pair[]) {
          const projName = str(jp.key);
          if (!projName) continue;
          const jm = mapNode(jp.value);
          const joinSpec: JoinSpec = { range: rangeOfPair(jp, text), projection: projName };
          if (jm) {
            joinSpec.type = str(getKey(jm, 'type')) as any;
            joinSpec.fields = strSeq(getKey(jm, 'fields'));
            const onNode = getKey(jm, 'on');
            const onm = mapNode(onNode);
            if (onm) {
              const pairsNode = seqNode(getKey(onm, 'pairs'));
              if (pairsNode) {
                joinSpec.on = {
                  pairs: pairsNode.items.map((pi) => {
                    const pm = mapNode(pi);
                    return { left: pm ? str(getKey(pm, 'left')) ?? '' : '', right: pm ? str(getKey(pm, 'right')) ?? '' : '' };
                  }),
                };
              } else {
                // Simple key: value form
                const simpleOn: Record<string, string> = {};
                for (const op of onm.items as YAML.Pair[]) {
                  const k = str(op.key);
                  if (k) simpleOn[k] = str(op.value) ?? '';
                }
                joinSpec.on = simpleOn;
              }
            }
          }
          q.joins[projName] = joinSpec;
        }
      }
    }
    result[name] = q;
  }
  return result;
}

function parseRelationships(m: YAML.YAMLMap, text: string): Record<string, RelationshipDefinition> {
  const result: Record<string, RelationshipDefinition> = {};
  for (const pair of m.items as YAML.Pair[]) {
    const name = str(pair.key);
    if (!name) continue;
    const r = rangeOfPair(pair, text);
    const vm = mapNode(pair.value);
    const rel: RelationshipDefinition = {
      kind: 'relationship', name, range: r,
      from: '', to: '', cardinality: 'many_to_many',
    };
    if (vm) {
      rel.from = str(getKey(vm, 'from')) ?? '';
      rel.to = str(getKey(vm, 'to')) ?? '';
      rel.cardinality = str(getKey(vm, 'cardinality')) as any ?? 'many_to_many';
      rel.unique = bool(getKey(vm, 'unique'));
      const emitNode = mapNode(getKey(vm, 'emit_events'));
      if (emitNode) {
        rel.emitEvents = {
          created: str(getKey(emitNode, 'created')),
          removed: str(getKey(emitNode, 'removed')),
        };
      }
    }
    result[name] = rel;
  }
  return result;
}

function parseListeners(seq: YAML.YAMLSeq, text: string): ListenerDefinition[] {
  return seq.items.map((node) => {
    const m = mapNode(node);
    if (!m) return null;
    const r = rangeOf(m, text);
    const listener: ListenerDefinition = {
      kind: 'listener', range: r,
      on: str(getKey(m, 'on')) ?? '',
      mutate: [],
    };
    listener.where = str(getKey(m, 'where'));
    listener.priority = num(getKey(m, 'priority'));
    const mutateSeq = seqNode(getKey(m, 'mutate'));
    if (mutateSeq) {
      listener.mutate = mutateSeq.items.map((mi) => {
        const mm = mapNode(mi);
        if (!mm) return null;
        return {
          range: rangeOf(mm, text),
          op: str(getKey(mm, 'op')) ?? '',
          field: str(getKey(mm, 'field')),
          value: scalarValue(getKey(mm, 'value')) ?? str(getKey(mm, 'value')),
        };
      }).filter(Boolean) as any[];
    }
    return listener;
  }).filter(Boolean) as ListenerDefinition[];
}

function parseSchemaFieldMap(node: unknown, text: string): Record<string, DecisionSchemaField> {
  const m = mapNode(node);
  const result: Record<string, DecisionSchemaField> = {};
  if (!m) return result;
  for (const pair of m.items as YAML.Pair[]) {
    const name = str(pair.key);
    if (!name) continue;
    const r = rangeOfPair(pair, text);
    const vm = mapNode(pair.value);
    const field: DecisionSchemaField = { range: r };
    if (vm) {
      field.type = str(getKey(vm, 'type'));
      field.required = bool(getKey(vm, 'required'));
    } else {
      const s = str(pair.value);
      if (s) field.type = s;
    }
    result[name] = field;
  }
  return result;
}

function parsePrompts(m: YAML.YAMLMap, text: string): Record<string, PromptDefinition> {
  const result: Record<string, PromptDefinition> = {};
  for (const pair of m.items as YAML.Pair[]) {
    const name = str(pair.key);
    if (!name) continue;
    const r = rangeOfPair(pair, text);
    const vm = mapNode(pair.value);
    result[name] = {
      kind: 'prompt',
      name,
      range: r,
      instructions: vm ? str(getKey(vm, 'instructions')) : str(pair.value),
    };
  }
  return result;
}

function parseDecisions(m: YAML.YAMLMap, text: string): Record<string, DecisionDefinition> {
  const result: Record<string, DecisionDefinition> = {};
  for (const pair of m.items as YAML.Pair[]) {
    const name = str(pair.key);
    if (!name) continue;
    const r = rangeOfPair(pair, text);
    const vm = mapNode(pair.value);
    const decision: DecisionDefinition = {
      kind: 'decision',
      name,
      range: r,
    };
    if (vm) {
      decision.provider = str(getKey(vm, 'provider'));
      decision.executor = str(getKey(vm, 'executor'));
      decision.model = str(getKey(vm, 'model'));
      decision.prompt = str(getKey(vm, 'prompt'));
      decision.emits = str(getKey(vm, 'emits'));
      decision.input = parseSchemaFieldMap(getKey(vm, 'input'), text);
      decision.output = parseSchemaFieldMap(getKey(vm, 'output'), text);
      decision.temperature = num(getKey(vm, 'temperature'));
      decision.maxTokens = num(getKey(vm, 'max_tokens'));
      decision.timeout = str(getKey(vm, 'timeout'));
      decision.retries = num(getKey(vm, 'retries'));
      const memoriesSeq = seqNode(getKey(vm, 'memory')) ?? seqNode(getKey(vm, 'memories'));
      if (memoriesSeq) {
        decision.memories = memoriesSeq.items
          .map((item) => str(item))
          .filter(Boolean) as string[];
      }
    }
    result[name] = decision;
  }
  return result;
}

function parseMemories(m: YAML.YAMLMap, text: string): Record<string, MemoryDefinition> {
  const result: Record<string, MemoryDefinition> = {};
  for (const pair of m.items as YAML.Pair[]) {
    const name = str(pair.key);
    if (!name) continue;
    const r = rangeOfPair(pair, text);
    const vm = mapNode(pair.value);
    const memory: MemoryDefinition = {
      kind: 'memory',
      name,
      range: r,
    };
    if (vm) {
      memory.sourceEvents = strSeq(getKey(vm, 'source_events'));
      memory.partitionBy = str(getKey(vm, 'partition_by'));
      memory.content = str(getKey(vm, 'content'));
      const embeddingNode = mapNode(getKey(vm, 'embedding'));
      if (embeddingNode) {
        memory.embedding = {
          provider: str(getKey(embeddingNode, 'provider')),
          executor: str(getKey(embeddingNode, 'executor')),
          model: str(getKey(embeddingNode, 'model')),
        };
      }
    }
    result[name] = memory;
  }
  return result;
}

function parseProviders(m: YAML.YAMLMap, text: string): Record<string, ProviderDefinition> {
  const result: Record<string, ProviderDefinition> = {};
  for (const pair of m.items as YAML.Pair[]) {
    const name = str(pair.key);
    if (!name) continue;
    const r = rangeOfPair(pair, text);
    const vm = mapNode(pair.value);
    const provider: ProviderDefinition = {
      kind: 'provider',
      name,
      range: r,
    };
    if (vm) {
      provider.executor = str(getKey(vm, 'executor'));
      provider.model = str(getKey(vm, 'model'));
      provider.temperature = num(getKey(vm, 'temperature'));
      provider.maxTokens = num(getKey(vm, 'max_tokens'));
      provider.timeout = str(getKey(vm, 'timeout'));
    }
    result[name] = provider;
  }
  return result;
}

function parseSagas(m: YAML.YAMLMap, text: string): Record<string, SagaDefinition> {
  const result: Record<string, SagaDefinition> = {};
  for (const pair of m.items as YAML.Pair[]) {
    const name = str(pair.key);
    if (!name) continue;
    const r = rangeOfPair(pair, text);
    const vm = mapNode(pair.value);
    const saga: SagaDefinition = {
      kind: 'saga', name, range: r,
      state: '', statePath: '', steps: [],
    };
    if (vm) {
      saga.state = str(getKey(vm, 'state')) ?? '';
      saga.statePath = str(getKey(vm, 'state_path')) ?? '';
      const stepsSeq = seqNode(getKey(vm, 'steps'));
      if (stepsSeq) {
        saga.steps = stepsSeq.items.map((item: unknown) => {
          const sm = mapNode(item);
          if (!sm) return null;
          const sr = rangeOf(sm, text);
          const step: SagaStep = {
            range: sr,
            name: str(getKey(sm, 'name')) ?? '',
            on: str(getKey(sm, 'on')),
            end: bool(getKey(sm, 'end')),
          };
          const setNode = mapNode(getKey(sm, 'set'));
          if (setNode) {
            step.set = {};
            for (const sp of setNode.items as YAML.Pair[]) {
              const k = str(sp.key);
              if (k) step.set[k] = scalarValue(sp.value);
            }
          }
          return step;
        }).filter(Boolean) as SagaStep[];
      }
    }
    result[name] = saga;
  }
  return result;
}

function parseResources(m: YAML.YAMLMap, text: string): Record<string, ResourceDefinition> {
  const result: Record<string, ResourceDefinition> = {};
  for (const pair of m.items as YAML.Pair[]) {
    const name = str(pair.key);
    if (!name) continue;
    const r = rangeOfPair(pair, text);
    const vm = mapNode(pair.value);
    const entries: Record<string, unknown> = {};
    if (vm) {
      for (const ep of vm.items as YAML.Pair[]) {
        const k = str(ep.key);
        if (!k) continue;
        const em = mapNode(ep.value);
        if (em) {
          const obj: Record<string, unknown> = {};
          for (const fp of em.items as YAML.Pair[]) {
            const fk = str(fp.key);
            if (fk) obj[fk] = scalarValue(fp.value) ?? str(fp.value);
          }
          entries[k] = obj;
        } else {
          entries[k] = scalarValue(ep.value) ?? str(ep.value);
        }
      }
    }
    result[name] = { kind: 'resource', name, range: r, entries };
  }
  return result;
}

function parseCommitEnvelopes(m: YAML.YAMLMap, text: string): Record<string, CommitEnvelopeDefinition> {
  const result: Record<string, CommitEnvelopeDefinition> = {};
  for (const pair of m.items as YAML.Pair[]) {
    const name = str(pair.key);
    if (!name) continue;
    const r = rangeOfPair(pair, text);
    const vm = mapNode(pair.value);
    const def: CommitEnvelopeDefinition = { kind: 'commitEnvelope', name, range: r };
    if (vm) {
      def.startAction = str(getKey(vm, 'start_action'));
      def.envelopeState = str(getKey(vm, 'envelope_state'));
      def.envelopeStatePath = str(getKey(vm, 'envelope_state_path'));

      const lcNode = mapNode(getKey(vm, 'lifecycle'));
      if (lcNode) {
        def.lifecycle = {
          prepareEvent: str(getKey(lcNode, 'prepare_event')),
          preparedEvent: str(getKey(lcNode, 'prepared_event')),
          commitEvent: str(getKey(lcNode, 'commit_event')),
          abortEvent: str(getKey(lcNode, 'abort_event')),
        };
      }

      const toNode = mapNode(getKey(vm, 'timeout'));
      if (toNode) {
        def.timeout = {
          abortAfterSeconds: num(getKey(toNode, 'abort_after_seconds')),
          tickEvent: str(getKey(toNode, 'tick_event')),
        };
      }

      const causalNode = mapNode(getKey(vm, 'causal_ordering'));
      if (causalNode) {
        def.causalOrdering = {
          mode: str(getKey(causalNode, 'mode')) as any,
          cursorField: str(getKey(causalNode, 'cursor_field')),
          seqSource: str(getKey(causalNode, 'seq_source')),
        };
      }

      const partsSeq = seqNode(getKey(vm, 'participants'));
      if (partsSeq) {
        def.participants = partsSeq.items.map((item: unknown) => {
          const pm = mapNode(item);
          if (!pm) return null;
          const pr = rangeOf(pm, text);
          const participant: CommitEnvelopeParticipant = {
            range: pr,
            name: str(getKey(pm, 'name')) ?? '',
            state: str(getKey(pm, 'state')),
            entityExpr: str(getKey(pm, 'entity_expr')),
            deltaExpr: str(getKey(pm, 'delta_expr')),
          };
          const vgNode = mapNode(getKey(pm, 'visibility_gate'));
          if (vgNode) {
            participant.visibilityGate = {
              strategy: str(getKey(vgNode, 'strategy')) as any,
              visiblePath: str(getKey(vgNode, 'visible_path')),
              pendingPath: str(getKey(vgNode, 'pending_path')),
            };
          }
          return participant;
        }).filter(Boolean) as CommitEnvelopeParticipant[];
      }
    }
    result[name] = def;
  }
  return result;
}

function parseIncludes(m: YAML.YAMLMap, text: string): IncludesSection {
  const r = rangeOf(m, text);
  return {
    range: r,
    states: strSeq(getKey(m, 'states')),
    events: strSeq(getKey(m, 'events')),
    actions: strSeq(getKey(m, 'actions')),
    projections: strSeq(getKey(m, 'projections')),
    queries: strSeq(getKey(m, 'queries')),
    relationships: strSeq(getKey(m, 'relationships')),
    sagas: strSeq(getKey(m, 'sagas')),
    resources: strSeq(getKey(m, 'resources')),
    commitEnvelopes: strSeq(getKey(m, 'commit_envelopes')),
    listeners: strSeq(getKey(m, 'listeners')),
    prompts: strSeq(getKey(m, 'prompts')),
    decisions: strSeq(getKey(m, 'decisions')),
    memories: strSeq(getKey(m, 'memories')),
    providers: strSeq(getKey(m, 'providers')),
  };
}

// ---------------------------------------------------------------------------
// Main parse entry point
// ---------------------------------------------------------------------------

export interface ParseResult {
  document: CausetDocument;
  symbols: WorkspaceSymbol[];
}

export function parseCausetDocument(uri: string, text: string): ParseResult {
  const doc: CausetDocument = {
    uri,
    text,
    errors: [],
    state: undefined,
    events: undefined,
    actions: undefined,
    projections: undefined,
    queries: undefined,
    relationships: undefined,
    listeners: undefined,
    sagas: undefined,
    resources: undefined,
    commitEnvelopes: undefined,
    prompts: undefined,
    decisions: undefined,
    memories: undefined,
    providers: undefined,
  };
  const symbols: WorkspaceSymbol[] = [];

  // Parse YAML with error recovery
  let yamlDoc: YAML.Document;
  try {
    yamlDoc = YAML.parseDocument(text, { keepSourceTokens: true });
  } catch (e: any) {
    doc.errors.push({
      message: `YAML parse error: ${e.message}`,
      range: zeroRange(),
      severity: 'error',
      code: 'YAML_PARSE',
    });
    return { document: doc, symbols };
  }

  // Collect YAML errors
  if (yamlDoc.errors) {
    for (const err of yamlDoc.errors) {
      doc.errors.push({
        message: err.message,
        range: err.pos ? {
          start: posFromOffset(text, err.pos[0]),
          end: posFromOffset(text, err.pos[1] ?? err.pos[0]),
        } : zeroRange(),
        severity: 'error',
        code: 'YAML_PARSE',
      });
    }
  }

  const root = mapNode(yamlDoc.contents);
  if (!root) return { document: doc, symbols };

  // dsl_version
  const dslVersionNode = getKey(root, 'dsl_version');
  if (dslVersionNode != null) {
    doc.dslVersion = num(dslVersionNode) ?? 1;
  }

  // app
  doc.app = str(getKey(root, 'app'));

  // includes
  const includesNode = mapNode(getKey(root, 'includes'));
  if (includesNode) {
    doc.includes = parseIncludes(includesNode, text);
  }

  // state
  const stateNode = mapNode(getKey(root, 'state'));
  if (stateNode) {
    doc.state = parseState(stateNode, text);
    for (const [name, entity] of Object.entries(doc.state)) {
      symbols.push({ name, kind: 'entity', uri, range: entity.range });
    }
  }

  // events
  const eventsNode = mapNode(getKey(root, 'events'));
  if (eventsNode) {
    doc.events = parseEvents(eventsNode, text);
    for (const [name, ev] of Object.entries(doc.events)) {
      symbols.push({ name, kind: 'event', uri, range: ev.range, detail: ev.state });
    }
  }

  // actions
  const actionsNode = mapNode(getKey(root, 'actions'));
  if (actionsNode) {
    doc.actions = parseActions(actionsNode, text);
    for (const [name, action] of Object.entries(doc.actions)) {
      symbols.push({ name, kind: 'action', uri, range: action.range, detail: action.state });
    }
  }

  // projections
  const projectionsNode = mapNode(getKey(root, 'projections'));
  if (projectionsNode) {
    doc.projections = parseProjections(projectionsNode, text);
    for (const [name, proj] of Object.entries(doc.projections)) {
      symbols.push({ name, kind: 'projection', uri, range: proj.range, detail: proj.target.table });
    }
  }

  // queries
  const queriesNode = mapNode(getKey(root, 'queries'));
  if (queriesNode) {
    doc.queries = parseQueries(queriesNode, text);
    for (const [name, q] of Object.entries(doc.queries)) {
      symbols.push({ name, kind: 'query', uri, range: q.range, detail: q.from });
    }
  }

  // relationships
  const relNode = mapNode(getKey(root, 'relationships'));
  if (relNode) {
    doc.relationships = parseRelationships(relNode, text);
    for (const [name, rel] of Object.entries(doc.relationships)) {
      symbols.push({ name, kind: 'relationship', uri, range: rel.range, detail: `${rel.from} → ${rel.to}` });
    }
  }

  // listeners
  const listenersNode = seqNode(getKey(root, 'listeners'));
  if (listenersNode) {
    doc.listeners = parseListeners(listenersNode, text);
  }

  // sagas
  const sagasNode = mapNode(getKey(root, 'sagas'));
  if (sagasNode) {
    doc.sagas = parseSagas(sagasNode, text);
    for (const [name, saga] of Object.entries(doc.sagas)) {
      symbols.push({ name, kind: 'saga', uri, range: saga.range, detail: saga.state });
    }
  }

  // resources
  const resourcesNode = mapNode(getKey(root, 'resources'));
  if (resourcesNode) {
    doc.resources = parseResources(resourcesNode, text);
    for (const [name, res] of Object.entries(doc.resources)) {
      symbols.push({ name, kind: 'resource', uri, range: res.range });
    }
  }

  // commit_envelopes
  const envelopesNode = mapNode(getKey(root, 'commit_envelopes'));
  if (envelopesNode) {
    doc.commitEnvelopes = parseCommitEnvelopes(envelopesNode, text);
    for (const [name, env] of Object.entries(doc.commitEnvelopes)) {
      symbols.push({ name, kind: 'commitEnvelope', uri, range: env.range, detail: env.startAction });
    }
  }

  // prompts
  const promptsNode = mapNode(getKey(root, 'prompts'));
  if (promptsNode) {
    doc.prompts = parsePrompts(promptsNode, text);
    for (const [name, prompt] of Object.entries(doc.prompts)) {
      symbols.push({ name, kind: 'prompt', uri, range: prompt.range });
    }
  }

  // decisions
  const decisionsNode = mapNode(getKey(root, 'decisions'));
  if (decisionsNode) {
    doc.decisions = parseDecisions(decisionsNode, text);
    for (const [name, decision] of Object.entries(doc.decisions)) {
      symbols.push({
        name,
        kind: 'decision',
        uri,
        range: decision.range,
        detail: decision.emits
          ? `emits: ${decision.emits}`
          : decision.provider ?? decision.executor,
      });
    }
  }

  // providers
  const providersNode = mapNode(getKey(root, 'providers'));
  if (providersNode) {
    doc.providers = parseProviders(providersNode, text);
    for (const [name, provider] of Object.entries(doc.providers)) {
      symbols.push({
        name,
        kind: 'provider',
        uri,
        range: provider.range,
        detail: provider.executor ? `executor: ${provider.executor}` : undefined,
      });
    }
  }

  // memories (parse after providers so embedding refs resolve in diagnostics)
  const memoriesNode = mapNode(getKey(root, 'memories'));
  if (memoriesNode) {
    doc.memories = parseMemories(memoriesNode, text);
    for (const [name, memory] of Object.entries(doc.memories)) {
      symbols.push({
        name,
        kind: 'memory',
        uri,
        range: memory.range,
        detail: memory.partitionBy ? `partition: ${memory.partitionBy}` : undefined,
      });
    }
  }

  return { document: doc, symbols };
}

// ---------------------------------------------------------------------------
// Semantic validation helpers (used by diagnostics provider)
// ---------------------------------------------------------------------------

export function collectEventNames(doc: CausetDocument): Set<string> {
  return new Set(Object.keys(doc.events ?? {}));
}

export function collectEntityNames(doc: CausetDocument): Set<string> {
  return new Set(Object.keys(doc.state ?? {}));
}

export function collectProjectionNames(doc: CausetDocument): Set<string> {
  return new Set(Object.keys(doc.projections ?? {}));
}

export function collectActionNames(doc: CausetDocument): Set<string> {
  return new Set(Object.keys(doc.actions ?? {}));
}

export function collectDecisionNames(doc: CausetDocument): Set<string> {
  return new Set(Object.keys(doc.decisions ?? {}));
}

export function collectPromptNames(doc: CausetDocument): Set<string> {
  return new Set(Object.keys(doc.prompts ?? {}));
}

export function collectMemoryNames(doc: CausetDocument): Set<string> {
  return new Set(Object.keys(doc.memories ?? {}));
}

export function collectProviderNames(doc: CausetDocument): Set<string> {
  return new Set(Object.keys(doc.providers ?? {}));
}

export function collectQueryNames(doc: CausetDocument): Set<string> {
  return new Set(Object.keys(doc.queries ?? {}));
}
