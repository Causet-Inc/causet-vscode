/**
 * Document formatter for Causet DSL.
 *
 * Normalizes:
 *  - Trailing whitespace
 *  - Indentation (2 spaces, no tabs)
 *  - Blank lines (max 1 consecutive blank line)
 *  - Trailing newline at EOF
 *
 * Preserves:
 *  - Comments
 *  - Ordering (never reorders keys)
 *  - Expressions
 *  - Alignment intent
 */

import { TextEdit, Range as LspRange, FormattingOptions } from 'vscode-languageserver/node.js';

export function provideFormatting(text: string, options: FormattingOptions): TextEdit[] {
  const lines = text.split('\n');
  const formatted: string[] = [];
  let consecutiveBlanks = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    // Trailing whitespace
    const stripped = raw.replace(/\s+$/, '');

    // Blank line de-duplication
    if (/^\s*$/.test(stripped)) {
      if (consecutiveBlanks < 1) {
        formatted.push('');
        consecutiveBlanks++;
      }
      continue;
    }
    consecutiveBlanks = 0;

    // Tab → spaces conversion
    const detabbed = stripped.replace(/\t/g, ' '.repeat(options.tabSize ?? 2));

    formatted.push(detabbed);
  }

  // Ensure single trailing newline
  while (formatted.length > 0 && formatted[formatted.length - 1] === '') {
    formatted.pop();
  }
  formatted.push('');

  const newText = formatted.join('\n');
  if (newText === text) return [];

  // Return a single whole-document replacement
  const endLine = lines.length - 1;
  const endChar = lines[endLine]?.length ?? 0;
  const fullRange: LspRange = {
    start: { line: 0, character: 0 },
    end: { line: endLine, character: endChar },
  };

  return [TextEdit.replace(fullRange, newText)];
}
