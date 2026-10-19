// Parsing with web-tree-sitter (ADR 0001) and declaration extraction with our query files.
// analyze.ts builds changed entities and hunk attribution on top of this.
import { Parser, type Node, type Tree } from 'web-tree-sitter';
import type { FileChange } from '../../schemas/changeset.ts';
import type { SourceRange } from '../../schemas/common.ts';
import { detectLanguage, loadedLanguage, loadLanguage, type GrammarName } from './languages.ts';

/**
 * A parsed file. The tree lives in WASM memory and is not garbage-collected: call
 * `freeTrees()` (or `tree.delete()`) when done. Nodes and declarations are invalid after that.
 */
export interface ParsedFile {
  status: 'parsed';
  path: string;
  language: GrammarName;
  tree: Tree;
  /** Tree-sitter recovered from syntax errors; the tree has ERROR or MISSING nodes. */
  hasErrors: boolean;
}

/** No built-in grammar for this path. Reported, never thrown (design reference §10.8). */
export interface UnsupportedFile {
  status: 'unsupported';
  path: string;
  language: null;
}

export type ParseResult = ParsedFile | UnsupportedFile;

/** Both sides of a file change. A side is null when it has no content to parse. */
export interface ParsedVersions {
  old: ParseResult | null;
  new: ParseResult | null;
}

export type DeclarationKind =
  'function' | 'method' | 'constructor' | 'class' | 'interface' | 'enum' | 'type' | 'import';

export interface Declaration {
  kind: DeclarationKind;
  /** The declared name; for imports, the module specifier (`./pricing`, `os.path`, `a.b.C`). */
  name: string;
  /**
   * Matched a test convention: a JS/TS `describe`/`it`/`test` block, a pytest `test*`
   * function or `Test*` class, or a JUnit `@Test` method. JS/TS test blocks have kind
   * `function` and the block title as name.
   */
  test: boolean;
  /** The declaration node, without leading comments or (Python, TS class members) decorators. */
  range: SourceRange;
  nameRange: SourceRange;
  /** Valid until the tree is freed. */
  node: Node;
  nameNode: Node;
}

/**
 * Parses source files with the built-in grammars. One instance holds one tree-sitter parser;
 * grammars and queries are loaded on first use and shared by all instances.
 */
export class StructuralParser {
  #parser: Parser | undefined;

  async parse(path: string, source: string): Promise<ParseResult> {
    const grammar = detectLanguage(path);
    if (!grammar) return { status: 'unsupported', path, language: null };
    const { language } = await loadLanguage(grammar);
    this.#parser ??= new Parser();
    this.#parser.setLanguage(language);
    // Only null when no language is set or a progress callback cancels; neither applies.
    const tree = this.#parser.parse(source)!;
    return { status: 'parsed', path, language: grammar, tree, hasErrors: tree.rootNode.hasError };
  }

  /** Parses the old and new content of a file change, each with its own path's language. */
  async parseVersions(change: FileChange): Promise<ParsedVersions> {
    const old =
      change.oldPath !== null && change.oldContent !== null
        ? await this.parse(change.oldPath, change.oldContent)
        : null;
    const parsedNew =
      change.newPath !== null && change.newContent !== null
        ? await this.parse(change.newPath, change.newContent)
        : null;
    return { old, new: parsedNew };
  }

  /** Frees the parser. Trees it produced stay valid until freed themselves. */
  delete(): void {
    this.#parser?.delete();
    this.#parser = undefined;
  }
}

/** Frees the trees of parse results. Safe to call with unsupported or null results. */
export function freeTrees(...results: (ParseResult | ParsedVersions | null)[]): void {
  for (const result of results) {
    if (result === null) continue;
    if ('status' in result) {
      if (result.status === 'parsed') result.tree.delete();
    } else {
      freeTrees(result.old, result.new);
    }
  }
}

function toRange(node: Node): SourceRange {
  // Tree-sitter rows and columns are 0-based, columns in UTF-16 code units like SourceRange.
  return {
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column + 1,
  };
}

/**
 * The declarations our query file finds in a parsed file, in source order. When several
 * patterns capture the same declaration and name, the earliest pattern decides the kind and
 * any of them can mark it as a test.
 */
export function declarations(file: ParsedFile): Declaration[] {
  const query = loadedLanguage(file.language).declarations;
  const byKey = new Map<string, { pattern: number; declaration: Declaration }>();
  for (const match of query.matches(file.tree.rootNode)) {
    const definition = match.captures.find((c) => c.name.startsWith('definition.'));
    const nameNode = match.captures.find((c) => c.name === 'name')?.node;
    if (!definition || !nameNode) continue;
    const key = `${definition.node.id}:${nameNode.id}`;
    const test = match.setProperties?.['test'] === 'true';
    const existing = byKey.get(key);
    if (existing && existing.pattern <= match.patternIndex) {
      existing.declaration.test ||= test;
      continue;
    }
    byKey.set(key, {
      pattern: match.patternIndex,
      declaration: {
        kind: definition.name.slice('definition.'.length) as DeclarationKind,
        name: nameNode.text,
        test: test || (existing?.declaration.test ?? false),
        range: toRange(definition.node),
        nameRange: toRange(nameNode),
        node: definition.node,
        nameNode,
      },
    });
  }
  return [...byKey.values()]
    .map((v) => v.declaration)
    .sort(
      (a, b) =>
        a.node.startIndex - b.node.startIndex || a.nameNode.startIndex - b.nameNode.startIndex,
    );
}
