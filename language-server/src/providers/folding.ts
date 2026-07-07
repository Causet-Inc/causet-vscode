/**
 * Folding ranges provider.
 *
 * Generates folding ranges from YAML indentation levels so that projections,
 * events, actions, state blocks, queries, etc. all fold correctly.
 */

import { FoldingRange, FoldingRangeKind } from 'vscode-languageserver/node.js';

interface IndentFrame {
  line: number;
  indent: number;
}

export function provideFoldingRanges(text: string): FoldingRange[] {
  const lines = text.split('\n');
  const ranges: FoldingRange[] = [];

  // Region comment folding
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*#\s*region\b/.test(lines[i])) {
      const start = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s*#\s*endregion\b/.test(lines[j])) {
          ranges.push({ startLine: start, endLine: j, kind: FoldingRangeKind.Region });
          break;
        }
      }
    }
  }

  // Indentation-based folding
  // Walk line by line; when indent decreases, close the previous block.
  const stack: IndentFrame[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip blank lines and pure comments for indent tracking
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;

    const indent = line.search(/\S/);

    // Pop any frames with >= current indent
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      const frame = stack.pop()!;
      if (i - 1 > frame.line) {
        // Find actual last non-empty line
        let endLine = i - 1;
        while (endLine > frame.line && /^\s*$/.test(lines[endLine])) endLine--;
        if (endLine > frame.line) {
          ranges.push({ startLine: frame.line, endLine });
        }
      }
    }

    // Push a new frame if this line ends with ':'  (YAML block start)
    if (/:\s*(#.*)?$/.test(line.trimEnd()) || /:\s*$/.test(line.trimEnd())) {
      stack.push({ line: i, indent });
    }
  }

  // Close remaining frames at EOF
  const lastLine = lines.length - 1;
  while (stack.length > 0) {
    const frame = stack.pop()!;
    let endLine = lastLine;
    while (endLine > frame.line && /^\s*$/.test(lines[endLine])) endLine--;
    if (endLine > frame.line) {
      ranges.push({ startLine: frame.line, endLine });
    }
  }

  return ranges;
}
