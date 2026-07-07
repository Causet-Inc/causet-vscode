/**
 * Semantic tokens provider.
 *
 * Emits fine-grained semantic token data that themes can use to override or
 * augment the TextMate grammar colors. Operates on the parsed document model
 * rather than raw text patterns.
 */

import { SemanticTokens } from 'vscode-languageserver/node.js';
import type { CausetDocument, Range } from 'causet-shared';

// ---------------------------------------------------------------------------
// Token type / modifier tables (must match server.ts legend)
// ---------------------------------------------------------------------------

export const SEMANTIC_TOKEN_TYPES = [
  'namespace',       // 0  — event/entity/projection namespaces
  'type',            // 1  — SQL types in fields blocks
  'class',           // 2  — projection / table names
  'enum',            // 3  — SCREAMING_SNAKE event / action names
  'interface',       // 4  — relationship names
  'struct',          // 5  — entity / state names
  'typeParameter',   // 6  — scalar types (string, number, etc.)
  'parameter',       // 7  — input field names
  'variable',        // 8  — namespace prefixes (event, entity, etc.)
  'property',        // 9  — DSL keys
  'enumMember',      // 10 — constants (cardinality, direction, etc.)
  'event',           // 11 — event identifier values
  'function',        // 12 — query names / builtin functions
  'method',          // 13 — action names
  'macro',           // 14 — builtin functions
  'keyword',         // 15 — section headers / rule phases
  'modifier',        // 16 — nullable ? modifier
  'comment',         // 17 — comments
  'string',          // 18 — string values
  'number',          // 19 — numeric values
  'regexp',          // 20 — (reserved)
  'operator',        // 21 — operators and ops
];

export const SEMANTIC_TOKEN_MODIFIERS = [
  'declaration',    // 0 — defining occurrence
  'definition',     // 1
  'readonly',       // 2
  'static',         // 3
  'deprecated',     // 4
  'abstract',       // 5
  'async',          // 6
  'modification',   // 7
  'documentation',  // 8
  'defaultLibrary', // 9 — builtins
];

// Type/modifier indices for easy reference
const T = {
  NAMESPACE: 0, SQL_TYPE: 1, CLASS: 2, ENUM: 3, INTERFACE: 4,
  STRUCT: 5, TYPE_PARAM: 6, PARAM: 7, VARIABLE: 8, PROPERTY: 9,
  ENUM_MEMBER: 10, EVENT: 11, FUNCTION: 12, METHOD: 13, MACRO: 14,
  KEYWORD: 15, MODIFIER: 16, COMMENT: 17, STRING: 18, NUMBER: 19,
  OPERATOR: 21,
};
const M = {
  DECLARATION: 1 << 0, DEFINITION: 1 << 1, READONLY: 1 << 2,
  DEPRECATED: 1 << 4, DEFAULT_LIB: 1 << 9,
};

// ---------------------------------------------------------------------------
// Token builder
// ---------------------------------------------------------------------------

interface Token {
  line: number;
  char: number;
  length: number;
  tokenType: number;
  tokenModifiers: number;
}

function encodeTokens(tokens: Token[]): number[] {
  // Sort by line then character
  tokens.sort((a, b) => a.line !== b.line ? a.line - b.line : a.char - b.char);

  const data: number[] = [];
  let prevLine = 0;
  let prevChar = 0;

  for (const tok of tokens) {
    const deltaLine = tok.line - prevLine;
    const deltaChar = deltaLine === 0 ? tok.char - prevChar : tok.char;
    data.push(deltaLine, deltaChar, tok.length, tok.tokenType, tok.tokenModifiers);
    prevLine = tok.line;
    prevChar = tok.char;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Line-level pattern matching (fast path for semantic tokens)
// ---------------------------------------------------------------------------

const SECTION_HEADERS = /^(state|events|actions|projections|queries|relationships|listeners|sagas|resources|commit_envelopes|prompts|decisions|memories|providers|dsl_version|app|includes)(?=\s*:)/;
const RULE_PHASES = /^(preflight|core|side_effects?)\s*:/;
const SCREAMING_SNAKE = /\b([A-Z][A-Z0-9_]{2,})\b/g;
const SNAKE_NAME = /^(\s*)([a-z][a-z0-9_]+)\s*:/;
const DSL_KEYS_RE = /\b(entity_key|entity_expr|entity_id_expr|payload|target|primary_key|derive|mutations|aggregates?|indexes?|fields|rules|then|core|side_effects?|source_events|table|input|required|description|default|type|item_type|item_fields|op|path|value|event_type|intent_type|target_stream|target_entity|override|on|when|expr|from|where|order_by|group_by|joins?|left|right|eq|neq|gte|lte|gt|lt|in|nin|gte_window|like|ilike|limit|direction|distinct|count|coalesce_zero|preflight|message|code|name|priority|mutate|field|by|floor|bucket|interval|window|allowed|unique|cardinality|emit_events|created|removed|kind|cap|max|min|delay_seconds|relationship|to_id|from_id|into|as|state_path|steps|end|pairs|columns|lock_key|partition|shard_id|dsl_version|app|includes)\s*:/g;
const NAMESPACE_RE = /\b(event|entity|intent|input|state|projection|aggregate|global|platform|it|item|resources|derived)\./g;
const BUILTIN_RE = /\b(max|min|floor|size|sum|contains|map|concat|join|shard|coalesce|isnull|format_date|is_prev_day|hash|LOOKUP_FIELD|lookup)\s*\(/g;
const OP_VALUE_RE = /\bop:\s*(set|add|sub|unset|merge|push|remove|filter|find|map|sort|clone|if|for_each|foreach|stop|continue|emit|emit_each|submit|decision|reject|schedule|lock|unlock|lookup|relationship_create|relationship_remove|compute_regen|upsert|delete|replace|soft_delete|bulk_update|update|increment)\b/g;
const NUMBER_RE = /(?<=[:\s\[,])-?\d+(?:\.\d+)?(?=[,\s\]\}#]|$)/g;
const SQL_TYPE_RE = /\b(TEXT|INTEGER|BIGINT|BOOLEAN|FLOAT|DOUBLE|JSON|UUID|TIMESTAMP|DECIMAL|NUMERIC|SMALLINT)\b/g;
const SCALAR_TYPE_AFTER = /(?<=(?:type|item_type):\s*)(string|number|int|integer|decimal|boolean|bool|array|object|any|json|timestamp|datetime|date|uuid|float|double)/g;

export function provideSemanticTokens(doc: CausetDocument, text: string): SemanticTokens {
  const tokens: Token[] = [];

  const lines = text.split('\n');

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const trimmed = line.trimStart();
    const baseIndent = line.length - trimmed.length;

    // Comments — skip rest
    if (/^\s*#/.test(line)) continue;

    // Section headers
    {
      const m = trimmed.match(SECTION_HEADERS);
      if (m) {
        tokens.push({ line: lineIdx, char: baseIndent, length: m[1].length, tokenType: T.KEYWORD, tokenModifiers: M.DECLARATION });
      }
    }

    // Rule phases
    {
      const m = trimmed.match(RULE_PHASES);
      if (m) {
        tokens.push({ line: lineIdx, char: baseIndent, length: m[1].length, tokenType: T.KEYWORD, tokenModifiers: 0 });
      }
    }

    // DSL keys
    {
      let m: RegExpExecArray | null;
      const re = new RegExp(DSL_KEYS_RE.source, 'g');
      while ((m = re.exec(line)) !== null) {
        tokens.push({ line: lineIdx, char: m.index, length: m[1].length, tokenType: T.PROPERTY, tokenModifiers: 0 });
      }
    }

    // SCREAMING_SNAKE identifiers
    {
      let m: RegExpExecArray | null;
      const re = new RegExp(SCREAMING_SNAKE.source, 'g');
      while ((m = re.exec(line)) !== null) {
        // Determine if it's an event (in events block) or action (actions block)
        const isEvent = doc.events?.[m[1]] !== undefined;
        const isAction = doc.actions?.[m[1]] !== undefined;
        const isDecision = doc.decisions?.[m[1]] !== undefined;
        const tokenType = isAction ? T.METHOD : isEvent ? T.EVENT : isDecision ? T.FUNCTION : T.ENUM;
        const mods = (isEvent || isAction || isDecision) ? M.DECLARATION : 0;
        tokens.push({ line: lineIdx, char: m.index, length: m[1].length, tokenType, tokenModifiers: mods });
      }
    }

    // Namespace prefixes
    {
      let m: RegExpExecArray | null;
      const re = new RegExp(NAMESPACE_RE.source, 'g');
      while ((m = re.exec(line)) !== null) {
        tokens.push({ line: lineIdx, char: m.index, length: m[1].length, tokenType: T.VARIABLE, tokenModifiers: M.READONLY });
      }
    }

    // Builtin functions
    {
      let m: RegExpExecArray | null;
      const re = new RegExp(BUILTIN_RE.source, 'g');
      while ((m = re.exec(line)) !== null) {
        tokens.push({ line: lineIdx, char: m.index, length: m[1].length, tokenType: T.MACRO, tokenModifiers: M.DEFAULT_LIB });
      }
    }

    // Op values
    {
      let m: RegExpExecArray | null;
      const re = new RegExp(OP_VALUE_RE.source, 'g');
      while ((m = re.exec(line)) !== null) {
        const opStart = m.index + m[0].indexOf(m[1]);
        tokens.push({ line: lineIdx, char: opStart, length: m[1].length, tokenType: T.OPERATOR, tokenModifiers: 0 });
      }
    }

    // SQL types
    {
      let m: RegExpExecArray | null;
      const re = new RegExp(SQL_TYPE_RE.source, 'g');
      while ((m = re.exec(line)) !== null) {
        tokens.push({ line: lineIdx, char: m.index, length: m[1].length, tokenType: T.SQL_TYPE, tokenModifiers: 0 });
      }
    }

    // Scalar types after type: / item_type:
    {
      let m: RegExpExecArray | null;
      const re = new RegExp(SCALAR_TYPE_AFTER.source, 'g');
      while ((m = re.exec(line)) !== null) {
        tokens.push({ line: lineIdx, char: m.index, length: m[1].length, tokenType: T.TYPE_PARAM, tokenModifiers: 0 });
      }
    }

    // Numbers
    {
      let m: RegExpExecArray | null;
      const re = new RegExp(NUMBER_RE.source, 'g');
      while ((m = re.exec(line)) !== null) {
        tokens.push({ line: lineIdx, char: m.index, length: m[0].length, tokenType: T.NUMBER, tokenModifiers: 0 });
      }
    }

    // Snake-case projection/entity name definitions (key under section header)
    {
      const m = line.match(SNAKE_NAME);
      if (m && baseIndent === 2) {
        const nameStart = baseIndent;
        const name = m[2];
        const isProj = doc.projections?.[name] !== undefined;
        const isEntity = doc.state?.[name] !== undefined;
        const isQuery = doc.queries?.[name] !== undefined;
        const isRel = doc.relationships?.[name] !== undefined;
        const isSaga = doc.sagas?.[name] !== undefined;
        let tt = T.CLASS;
        if (isEntity) tt = T.STRUCT;
        else if (isQuery) tt = T.FUNCTION;
        else if (isRel) tt = T.INTERFACE;
        const mods = (isProj || isEntity || isQuery) ? M.DECLARATION : 0;
        tokens.push({ line: lineIdx, char: nameStart, length: name.length, tokenType: tt, tokenModifiers: mods });
      }
    }
  }

  return { data: encodeTokens(tokens) };
}
