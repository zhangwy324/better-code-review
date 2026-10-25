// Entities of one parsed file side (#15, design reference §8.3): the declarations our queries
// find, with spans extended over leading doc comments and decorators, enclosing containers, and
// the fingerprints before/after matching uses (match.ts). Entities hold no tree-sitter nodes, so
// the tree can be freed as soon as they are extracted.
import { createHash } from 'node:crypto';
import type { Node } from 'web-tree-sitter';
import type { SourceRange } from '../../schemas/common.ts';
import type { EntityKind } from '../../schemas/structural.ts';
import { declarations, type Declaration, type ParsedFile } from './parser.ts';

export type CodeEntityKind = Exclude<EntityKind, 'module'>;

/**
 * One entity on one side of a file. Declarations with the same container, name and kind are
 * one entity with several `members`: overloads, getter/setter pairs, redefinitions (#42).
 */
export interface Entity {
  kind: CodeEntityKind;
  name: string;
  /** Names of the enclosing entities, outermost first, joined with `.`; null at top level. */
  container: string | null;
  /** The enclosing entity on the same side, or null at top level. */
  parent: Entity | null;
  /** Number of enclosing entities. */
  depth: number;
  /** Each member's extent, including leading comments and decorators, in source order. */
  members: SourceRange[];
  /** From the first member's start to the last member's end. */
  range: SourceRange;
  /** A member matched a test convention (parser.ts `Declaration.test`). */
  test: boolean;
  /** Named by a title, not an identifier (parser.ts `Declaration.titled`). */
  titled: boolean;
  /** Hash of the code without comments, whitespace or the entity's own name. */
  contentHash: string;
  /** Parameters and return type as written, whitespace-normalised; null if there are none. */
  signature: string | null;
  /** Code tokens without the entity's own name, for fuzzy matching. */
  tokens: string[];
}

/** A span of whole lines, 1-based and inclusive. */
export interface LineRange {
  startLine: number;
  endLine: number;
}

/** What a file side yields besides its entities, for test classification. */
export interface FileFacts {
  entities: Entity[];
  /** Module specifiers of the file's imports (`vitest`, `pytest`, `org.junit.jupiter.api.Test`). */
  imports: string[];
  /** Line ranges of ERROR nodes, where tree-sitter could not parse the code. */
  errorLines: LineRange[];
}

/**
 * Nodes that wrap a single declaration without adding meaning. The entity's extent grows to the
 * wrapper, so `export`, `const` and decorators count as part of it.
 */
const WRAPPERS = new Set([
  'export_statement',
  'lexical_declaration',
  'variable_declaration',
  'expression_statement',
  'ambient_declaration',
  'decorated_definition',
]);
const COMMENTS = new Set(['comment', 'line_comment', 'block_comment']);

export function extractFacts(file: ParsedFile): FileFacts {
  const found = declarations(file);
  const imports = found.filter((d) => d.kind === 'import').map((d) => d.name);
  const code = found.filter(
    (d): d is Declaration & { kind: CodeEntityKind } => d.kind !== 'import',
  );

  // The anchor is the outermost wrapper; containment is decided on anchors.
  const anchors = new Map<number, Declaration>();
  for (const d of code) anchors.set(anchorOf(d.node).id, d);

  const byKey = new Map<string, Entity>();
  const entityOf = new Map<Declaration, Entity>();
  const entities: Entity[] = [];
  for (const d of code) {
    const anchor = anchorOf(d.node);
    const parent = enclosing(anchor, anchors, entityOf);
    const container = parent === null ? null : qualifiedName(parent);
    const key = JSON.stringify([container, d.kind, d.name]);
    const extent = extendOverLeading(anchor);
    const text = codeText(anchor, d.nameNode);
    let entity = byKey.get(key);
    if (entity === undefined) {
      entity = {
        kind: d.kind,
        name: d.name,
        container,
        parent,
        depth: parent === null ? 0 : parent.depth + 1,
        members: [],
        range: extent,
        test: false,
        titled: false,
        contentHash: '',
        signature: null,
        tokens: [],
      };
      byKey.set(key, entity);
      entities.push(entity);
    }
    entity.members.push(extent);
    entity.test ||= d.test;
    entity.titled ||= d.titled;
    entity.tokens.push(...tokenize(text));
    const signature = signatureOf(d.node);
    if (signature !== null) {
      entity.signature =
        entity.signature === null ? signature : `${entity.signature}; ${signature}`;
    }
    entityOf.set(d, entity);
  }
  for (const e of entities) {
    e.range = union(e.members);
    e.contentHash = createHash('sha256')
      .update(JSON.stringify([e.kind, e.tokens]))
      .digest('hex');
  }

  return { entities, imports, errorLines: errorLines(file.tree.rootNode) };
}

/** ERROR and MISSING nodes, found by descending only into subtrees that contain one. */
function errorLines(node: Node): LineRange[] {
  if (!node.hasError) return [];
  if (node.isError || node.isMissing) {
    return [{ startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 }];
  }
  return node.children.flatMap((c) => (c === null ? [] : errorLines(c)));
}

function anchorOf(node: Node): Node {
  let anchor = node;
  for (let parent = anchor.parent; parent && WRAPPERS.has(parent.type); parent = anchor.parent) {
    const wrapped = parent.namedChildren.filter(
      (c) => c !== null && !COMMENTS.has(c.type) && c.type !== 'decorator',
    );
    if (wrapped.length !== 1) break;
    anchor = parent;
  }
  return anchor;
}

/** The nearest entity whose anchor encloses `anchor`. Parents come first in source order. */
function enclosing(
  anchor: Node,
  anchors: Map<number, Declaration>,
  entityOf: Map<Declaration, Entity>,
): Entity | null {
  for (let node = anchor.parent; node; node = node.parent) {
    const d = anchors.get(node.id);
    if (d !== undefined) return entityOf.get(d) ?? null;
  }
  return null;
}

function qualifiedName(entity: Entity): string {
  return entity.container === null ? entity.name : `${entity.container}.${entity.name}`;
}

/**
 * The anchor's extent, extended back over the comments and decorators directly above it (#42):
 * no blank line in between, and not a trailing comment on the previous code's last line.
 */
function extendOverLeading(anchor: Node): SourceRange {
  let start = anchor;
  for (let prev = start.previousSibling; prev; prev = start.previousSibling) {
    if (!COMMENTS.has(prev.type) && prev.type !== 'decorator') break;
    if (prev.endPosition.row < start.startPosition.row - 1) break;
    const before = prev.previousSibling;
    if (before && before.endPosition.row === prev.startPosition.row) break;
    start = prev;
  }
  return {
    startLine: start.startPosition.row + 1,
    startColumn: start.startPosition.column + 1,
    endLine: anchor.endPosition.row + 1,
    endColumn: anchor.endPosition.column + 1,
  };
}

/** The anchor's text with comments and the entity's own name left out. */
function codeText(anchor: Node, nameNode: Node): string {
  const skip: Node[] = [nameNode, ...anchor.descendantsOfType([...COMMENTS]).filter((n) => !!n)];
  skip.sort((a, b) => a.startIndex - b.startIndex);
  let text = '';
  let pos = anchor.startIndex;
  for (const node of skip) {
    if (node.startIndex < pos) continue;
    text += sliceText(anchor, pos, node.startIndex) + ' ';
    pos = node.endIndex;
  }
  return text + sliceText(anchor, pos, anchor.endIndex);
}

function sliceText(anchor: Node, from: number, to: number): string {
  return anchor.text.slice(from - anchor.startIndex, to - anchor.startIndex);
}

const TOKEN = /[\p{L}\p{N}_$]+|\S/gu;

function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

/**
 * Parameters and return type of a function-like declaration. Declarations that hold a function
 * (`const f = () => …`, `obj.f = …`, `f = lambda …`) use the function's.
 */
function signatureOf(node: Node): string | null {
  const fn = node.childForFieldName('value') ?? node.childForFieldName('right') ?? node;
  const params = fn.childForFieldName('parameters') ?? fn.childForFieldName('parameter');
  if (params === null) return null;
  const returns = fn.childForFieldName('return_type') ?? fn.childForFieldName('type');
  // TypeScript's return type node includes the colon.
  const text =
    returns === null ? params.text : `${params.text} -> ${returns.text.replace(/^:\s*/, '')}`;
  return text.replace(/\s+/g, ' ');
}

function union(ranges: SourceRange[]): SourceRange {
  const first = ranges[0]!;
  const last = ranges.reduce((a, b) => (b.endLine > a.endLine ? b : a));
  return {
    startLine: first.startLine,
    startColumn: first.startColumn,
    endLine: last.endLine,
    endColumn: last.endColumn,
  };
}
