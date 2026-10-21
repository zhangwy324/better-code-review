// Syntax highlighting for the diff view (#29), with the Lezer parsers that CodeMirror uses. They
// are plain JavaScript, with no workers, WebAssembly or eval, so the page's Content-Security-Policy
// allows them. Highlighting only gives spans of a line class names; it never changes the text.
import type { Parser, Tree } from '@lezer/common';
import { classHighlighter, highlightTree } from '@lezer/highlight';
import { parser as java } from '@lezer/java';
import { parser as javascript } from '@lezer/javascript';
import { parser as python } from '@lezer/python';

/** By the structural analyzer's grammar names (`GraphFile.language`), the built-in languages. */
const PARSERS: Record<string, Parser> = {
  typescript: javascript.configure({ dialect: 'ts' }),
  tsx: javascript.configure({ dialect: 'ts jsx' }),
  javascript: javascript.configure({ dialect: 'jsx' }),
  python,
  java,
};

/** A highlighted span of one line: `from` and `to` are offsets into the line's text. */
export interface Token {
  from: number;
  to: number;
  /** Space-separated `tok-*` classes, e.g. `tok-variableName tok-definition`. */
  classes: string;
}

/** Highlights whole files, so that a line inside a multi-line string or comment is right too. */
export class Highlighter {
  private readonly text: string;
  private readonly tree: Tree;
  /** The offset of each line's first character. */
  private readonly starts: number[] = [0];

  /** Null when `language` has no parser. */
  static for(text: string, language: string | null): Highlighter | null {
    const parser = language === null ? undefined : PARSERS[language];
    return parser === undefined ? null : new Highlighter(text, parser);
  }

  private constructor(text: string, parser: Parser) {
    this.text = text;
    this.tree = parser.parse(text);
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
      this.starts.push(i + 1);
    }
  }

  /**
   * The tokens of 1-based `line`, which is expected to read `text`. None when it doesn't, so a
   * patch line that somehow differs from the file is shown plain rather than misstyled.
   */
  line(line: number, text: string): Token[] {
    const start = this.starts[line - 1];
    if (start === undefined) return [];
    const next = this.starts[line];
    const end = next === undefined ? this.text.length : next - 1;
    if (this.text.slice(start, end) !== text) return [];
    const tokens: Token[] = [];
    highlightTree(
      this.tree,
      classHighlighter,
      (from, to, classes) => {
        const a = Math.max(from, start);
        const b = Math.min(to, end);
        if (a < b) tokens.push({ from: a - start, to: b - start, classes });
      },
      start,
      end,
    );
    return tokens;
  }
}
