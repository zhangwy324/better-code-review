// Text-level helpers that make answers from different servers comparable: import lines,
// constructor call sites, receivers of method calls, unresolved-import diagnostics. Pure
// functions over source lines, so they are tested without a server.
import type { SourceRange } from '../../schemas/index.ts';
import type { Diagnostic, Range } from './protocol.ts';

/** LSP range (0-based, end exclusive) to the contracts' `SourceRange` (1-based, see README). */
export function toSourceRange(range: Range): SourceRange {
  return {
    startLine: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

/**
 * Whether a 1-based line and column fall inside a range. Match candidates to references with
 * this rather than by start column: jdtls starts `new Gson()` at `new` and reports a qualified
 * name such as `org.jsoup.nodes.Node` as one range (#42).
 */
export function rangeContains(range: SourceRange, line: number, column: number): boolean {
  const startColumn = range.startColumn ?? 1;
  const endColumn = range.endColumn ?? Number.POSITIVE_INFINITY;
  if (line < range.startLine || line > range.endLine) return false;
  if (line === range.startLine && column < startColumn) return false;
  if (line === range.endLine && column >= endColumn) return false;
  return true;
}

const IMPORT_START = /^\s*(?:import\b(?!\s*\()|from\s+[\w.]+\s+import\b)/;
const REQUIRE = /\brequire\s*\(\s*['"]/;
const CONTINUES = /[{(,\\]\s*$/;
const MAX_IMPORT_LINES = 200;

/**
 * Whether a 0-based line is part of an import statement (TS/JS `import`, `require`, Python
 * `import`/`from … import`, Java `import`), including a name inside a multi-line import list.
 *
 * TS 7's `references` leaves import lines out and tsserver's includes them; pyright includes
 * them. The session drops them from every server's answer, so all servers agree. An import is
 * not a caller (ADR 0001: import lines map to the module level, which text search covers).
 * Re-exports (`export { x } from`) are kept: they are how aliases are followed (#42).
 */
export function isImportLine(lines: readonly string[], line: number): boolean {
  const own = lines[line] ?? '';
  if (IMPORT_START.test(own) || REQUIRE.test(own)) return true;
  for (let i = line - 1; i >= 0 && line - i <= MAX_IMPORT_LINES; i--) {
    const text = stripLineComment(lines[i] ?? '');
    if (!CONTINUES.test(text)) return false;
    if (IMPORT_START.test(text)) return true;
  }
  return false;
}

function stripLineComment(text: string): string {
  return text.replace(/\s(?:\/\/|#).*$/, '');
}

/**
 * Whether a reference to a class name is a constructor call: `new Foo(`, `new a.b.Foo`,
 * `Foo(` (Python), `Foo<T>(`, or a range that itself starts with `new` (jdtls). Python
 * `__init__` has no references of its own, so constructors are queried through the class and
 * filtered with this (#42): type annotations, `isinstance(x, Foo)` and imports are not calls.
 */
export function isConstructorCall(lines: readonly string[], range: Range): boolean {
  const text = lines[range.start.line] ?? '';
  const own = text.slice(range.start.character);
  if (/^new\b/.test(own)) return true;
  if (/\bnew\s+(?:[\w$]+\s*\.\s*)*$/.test(text.slice(0, range.start.character))) return true;
  const endText = lines[range.end.line] ?? '';
  return /^\s*(?:<[^()]*>\s*)?\(/.test(endText.slice(range.end.character));
}

/**
 * Whether a reference is the alias name in `export { x as y }` or `import { x as y }`. tsserver
 * returns it, TS 7 does not; the use of the alias (`y(1)`) is returned by both and kept.
 */
export function isAliasDeclaration(lines: readonly string[], range: Range): boolean {
  return /\bas\s+$/.test((lines[range.start.line] ?? '').slice(0, range.start.character));
}

/**
 * Whether a method reference is a declaration (`area(): number {`, `def area(self):`,
 * `public double area() {`) rather than a call: tsserver lists the declarations of base and
 * sibling overrides among the references of an override; TS 7 and pyright do not.
 */
export function isMethodDeclaration(lines: readonly string[], range: Range): boolean {
  const text = lines[range.start.line] ?? '';
  const before = text.slice(0, range.start.character);
  const after = text.slice(range.end.character);
  if (/\b(?:def|function)\s+$/.test(before)) return true;
  if (/[=(.,!?&|+\-*/%]|\b(?:if|elif|while|for|return|await|yield|new)\b/.test(before))
    return false;
  return /^\s*(?:<[^()]*>)?\s*\(.*[{:]\s*$/.test(after);
}

export type Receiver =
  /** `x.name` or `x?.name`: query the type of `x` at `character` (0-based). */
  | { kind: 'identifier'; name: string; character: number }
  /** `super.name`: dispatched statically to the base, never to an override (#42). */
  | { kind: 'super' }
  /** `f().name`, `a[0].name`: no single token to ask the server about. */
  | { kind: 'expression' }
  /** No receiver: a bare call (`name()`, implicit `this` in Java) or a declaration. */
  | { kind: 'none' };

/** The receiver of a method reference starting at `character` on `lineText`. */
export function receiverOf(lineText: string, character: number): Receiver {
  const before = lineText.slice(0, character);
  if (!/(?:\?\.|\.)\s*$/.test(before)) return { kind: 'none' };
  const match = /([A-Za-z_$][\w$]*)\s*(?:\?\.|\.)\s*$/.exec(before);
  // `this.el.name` asks about `el`; `f().name` and `a[0].name` have no token to ask about.
  if (!match) return { kind: 'expression' };
  if (match[1] === 'super') return { kind: 'super' };
  return { kind: 'identifier', name: match[1]!, character: match.index };
}

const TYPE_DECLARATION =
  /\b(?:class|interface|enum|record|struct|trait|object|type)\s+([A-Za-z_$][\w$]*)/;

/**
 * The type name at a `typeDefinition` target: the identifier the range covers, or the name
 * declared at the start of a range that spans a whole declaration.
 */
export function typeNameAt(lines: readonly string[], range: Range): string | null {
  const first = lines[range.start.line] ?? '';
  if (range.start.line === range.end.line) {
    const exact = first.slice(range.start.character, range.end.character);
    if (/^[A-Za-z_$][\w$]*$/.test(exact)) return exact;
  }
  const head = [first.slice(range.start.character), ...lines.slice(range.start.line + 1)]
    .slice(0, 5)
    .join('\n');
  return TYPE_DECLARATION.exec(head)?.[1] ?? null;
}

/** A 0-based position, as in LSP. */
export interface TextPosition {
  line: number;
  character: number;
}

/** A type's declaration header: what it is, its name, and the bases it names directly. */
export interface TypeHeader {
  /** `class`, `interface`, `enum`, `record`, `type`, … */
  keyword: string;
  name: string;
  /** Where the name is declared. */
  at: TextPosition;
  /**
   * The bases written in the header (`extends`/`implements`, Python's parentheses), each at its
   * last identifier (`Base` in `m.Base<T>`), so a server can be asked where it is declared. Null
   * when one is not a plain dotted name (`extends mixin(A)`, `*bases`).
   */
  bases: { name: string; at: TextPosition }[] | null;
}

const HEADER_LINES = 20;
const DOTTED_BASE = /^\s*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*(?:[<[][\s\S]*)?$/;

/**
 * The header of the type declared at a `typeDefinition` or `definition` target (see
 * `typeNameAt`), for TS/JS, Java and Python. Null when there is no declaration of that name.
 */
export function typeHeaderAt(lines: readonly string[], range: Range): TypeHeader | null {
  const name = typeNameAt(lines, range);
  if (name === null) return null;
  const declaration = new RegExp(
    `\\b(class|interface|enum|record|struct|trait|object|type)\\s+(${name.replace(/\$/g, '\\$')})(?![\\w$])`,
  );
  for (let line = range.start.line; line < range.start.line + 5 && line < lines.length; line++) {
    const match = declaration.exec(lines[line]!);
    if (!match) continue;
    const character = match.index + match[0].length - name.length;
    // The text after the name, flattened, with a map back to positions.
    const text: string[] = [];
    const positions: TextPosition[] = [];
    for (let l = line; l < line + HEADER_LINES && l < lines.length; l++) {
      const from = l === line ? character + name.length : 0;
      const source = `${lines[l]!}\n`;
      for (let c = from; c < source.length; c++) {
        text.push(source[c]!);
        positions.push({ line: l, character: c });
      }
    }
    const bases = parseBases(match[1]!, text.join(''), positions);
    return { keyword: match[1]!, name, at: { line, character }, bases };
  }
  return null;
}

/** Bases in the header text after a type's name; see `TypeHeader.bases`. */
function parseBases(keyword: string, text: string, positions: TextPosition[]): TypeHeader['bases'] {
  let i = skipSpace(text, 0);
  // Type parameters: `<T>` (TS, Java), `[T]` (Python 3.12). A Java record's components.
  if (text[i] === '<' || text[i] === '[') i = skipSpace(text, closing(text, i));
  if (keyword === 'record' && text[i] === '(') i = skipSpace(text, closing(text, i));
  if (i < 0 || i > text.length) return null;
  const entries: [number, number][] = [];
  if (text[i] === '(') {
    // Python: `(A, m.B, Generic[T], metaclass=M)`.
    const end = closing(text, i);
    if (end < 0) return null;
    entries.push(...split(text, i + 1, end - 1));
  } else if (text[i] === ':' || text[i] === '{') {
    return [];
  } else {
    // TS/JS, Java: `extends A<T> implements B, C {`, ending at the body (`permits` ends it too).
    const body = depth0(text, i, text.length).find((k) => text[k] === '{');
    if (body === undefined) return null;
    const clauses: { word: string; from: number; start: number }[] = [];
    const words = /\b(extends|implements|permits)\b/g;
    const top = new Set(depth0(text, i, body));
    for (const m of text.slice(i, body).matchAll(words)) {
      const from = i + m.index;
      if (top.has(from)) clauses.push({ word: m[1]!, from, start: from + m[1]!.length });
    }
    const first = clauses[0]?.from ?? body;
    if (text.slice(i, first).trim() !== '') return null;
    for (let k = 0; k < clauses.length; k++) {
      const end = clauses[k + 1]?.from ?? body;
      if (clauses[k]!.word !== 'permits') entries.push(...split(text, clauses[k]!.start, end));
    }
  }
  const bases: NonNullable<TypeHeader['bases']> = [];
  for (const [start, end] of entries) {
    const entry = text.slice(start, end);
    if (entry.trim() === '') continue;
    // Python keyword arguments (`metaclass=M`) are not bases.
    if (/^\s*[A-Za-z_]\w*\s*=(?!=)/.test(entry)) continue;
    const dotted = DOTTED_BASE.exec(entry);
    if (!dotted) return null;
    const last = /([A-Za-z_$][\w$]*)$/.exec(dotted[1]!)!;
    const offset = start + entry.indexOf(dotted[1]!) + last.index;
    bases.push({ name: last[1]!, at: positions[offset]! });
  }
  return bases;
}

function skipSpace(text: string, i: number): number {
  if (i < 0) return i;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  return i;
}

const OPEN: Record<string, string> = { '(': ')', '[': ']', '<': '>', '{': '}' };

/** The index after the bracket that closes the one at `i`, or -1. `=>` is not a bracket. */
function closing(text: string, i: number): number {
  const stack: string[] = [];
  for (let k = i; k < text.length; k++) {
    const ch = text[k]!;
    if (ch === '>' && text[k - 1] === '=') continue;
    if (OPEN[ch]) stack.push(OPEN[ch]);
    else if (ch === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return k + 1;
    } else if (')]}>'.includes(ch)) return -1;
  }
  return -1;
}

/** The indices in `[start, end)` at bracket depth 0, counting from `start`. */
function depth0(text: string, start: number, end: number): number[] {
  const out: number[] = [];
  let depth = 0;
  for (let k = start; k < end; k++) {
    const ch = text[k]!;
    const arrow = ch === '>' && text[k - 1] === '=';
    if (!arrow && ')]>'.includes(ch)) depth--;
    if (depth === 0) out.push(k);
    if ('([<'.includes(ch)) depth++;
  }
  return out;
}

/** `[start, end)` ranges between commas at depth 0. */
function split(text: string, start: number, end: number): [number, number][] {
  const parts: [number, number][] = [];
  let from = start;
  for (const k of depth0(text, start, end)) {
    if (text[k] === ',') {
      parts.push([from, k]);
      from = k + 1;
    }
  }
  parts.push([from, end]);
  return parts;
}

/** Number of import statements in a file, approximately (one per statement, not per name). */
export function countImports(text: string): number {
  let count = 0;
  for (const line of text.split('\n')) {
    if (IMPORT_START.test(line) || REQUIRE.test(line)) count++;
  }
  return count;
}

/** pyright, tsserver/TS 7 and jdtls codes for "this import does not resolve". */
const UNRESOLVED_IMPORT_CODES = new Set<string | number>([
  'reportMissingImports',
  2307, // Cannot find module '…' or its corresponding type declarations.
  2792, // Cannot find module '…'. Did you mean to set the 'moduleResolution' option …?
  268435846, // jdtls: The import … cannot be resolved.
  '268435846',
]);

export function isUnresolvedImport(diagnostic: Diagnostic): boolean {
  if (diagnostic.code !== undefined && UNRESOLVED_IMPORT_CODES.has(diagnostic.code)) return true;
  return /^(?:Import "[^"]*" could not be resolved$|Cannot find module|The import .* cannot be resolved)/.test(
    diagnostic.message,
  );
}
