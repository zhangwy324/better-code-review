// Text search and the tree-sitter filter (#17, pipeline steps 1 and 2): every whole-word
// occurrence of a searched name in a parsed file, classified by the syntax node it falls on.
// Comments, strings, declarations of a name, object keys and import or re-export lines are
// skipped; what is left is a code hit with its shape (call or reference, receiver, base-class
// list, constructor chaining), which the later steps decide on.
import type { Node } from 'web-tree-sitter';
import type { ParsedFile } from '../structural/parser.ts';
import { escapeRegExp } from './snapshot-files.ts';

/** Leaf node types that name something in code. Anything else (comments, strings) is skipped. */
const NAME_NODES = new Set([
  'identifier',
  'property_identifier',
  'type_identifier',
  'shorthand_property_identifier',
  'private_property_identifier',
  'super',
  'this',
]);

/** Declarations whose `name` field declares the hit rather than using it. */
const DECLARING_PARENTS = new Set([
  // TypeScript and JavaScript
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'function_signature',
  'class_declaration',
  'abstract_class_declaration',
  'class',
  'method_definition',
  'method_signature',
  'abstract_method_signature',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'internal_module',
  'module',
  'variable_declarator',
  'public_field_definition',
  'property_signature',
  // Python
  'function_definition',
  'class_definition',
  'default_parameter',
  'typed_default_parameter',
  // Java
  'method_declaration',
  'constructor_declaration',
  'compact_constructor_declaration',
  'record_declaration',
  'annotation_type_declaration',
  'enum_constant',
  'formal_parameter',
  'spread_parameter',
  'catch_formal_parameter',
]);

/** Parameter lists whose direct identifier children are declarations (Python, TS arrows). */
const PARAMETER_LISTS = new Set(['parameters', 'lambda_parameters', 'typed_parameter']);

const IMPORT_STATEMENTS = new Set([
  'import_statement',
  'import_from_statement',
  'future_import_statement',
  'import_declaration',
  'package_declaration',
]);

/** Base-class and interface lists: a hit there is an `implements` relation. */
const HERITAGE = new Set([
  'class_heritage',
  'extends_clause',
  'implements_clause',
  'extends_type_clause',
  'superclass',
  'super_interfaces',
  'extends_interfaces',
]);

export const CLASS_NODES = new Set([
  'class_declaration',
  'abstract_class_declaration',
  'class',
  'class_definition',
  'record_declaration',
  'enum_declaration',
  'interface_declaration',
]);

export interface Hit {
  /** The searched word, as written. */
  name: string;
  /** 1-based, UTF-16 columns like `SourceRange`; `endColumn` is exclusive. */
  line: number;
  column: number;
  endColumn: number;
  /** The hit is the callee: `f(…)`, `x.f(…)`, `new F(…)`, `super(…)`. */
  call: boolean;
  /** The receiver's text for `x.f`, or null for a bare name. */
  receiver: string | null;
  /** The receiver is a single identifier (`t.tax`), so import resolution can look it up. */
  simpleReceiver: boolean;
  /** In a base-class or interface list. */
  heritage: boolean;
  /** `super(…)` / `this(…)` constructor chaining, or Python `super().__init__(…)`. */
  chaining: 'super' | 'this' | null;
  /** The enclosing class's name and its direct base names, for constructor chaining. */
  enclosingClass: { name: string; bases: string[] } | null;
}

/** Why an occurrence was not kept. Counted, not reported per occurrence. */
export type SkipReason = 'not-code' | 'declaration' | 'key' | 'import';

export interface FileHits {
  hits: Hit[];
  skipped: Record<SkipReason, number>;
}

/** Every occurrence of the `words` in the file, classified. In source order. */
export function findHits(file: ParsedFile, source: string, words: Iterable<string>): FileHits {
  const result: FileHits = {
    hits: [],
    skipped: { 'not-code': 0, declaration: 0, key: 0, import: 0 },
  };
  const unique = [...new Set(words)].filter((w) => w.length > 0);
  if (unique.length === 0) return result;
  const pattern = new RegExp(`(?<![\\w$])(?:${unique.map(escapeRegExp).join('|')})(?![\\w$])`, 'g');
  const lines = source.split('\n');
  for (const [row, text] of lines.entries()) {
    for (const match of text.matchAll(pattern)) {
      const node = file.tree.rootNode.descendantForPosition(
        { row, column: match.index },
        { row, column: match.index + match[0].length },
      );
      const verdict = node === null ? 'not-code' : classify(node, match[0]);
      if (typeof verdict === 'string') {
        result.skipped[verdict]++;
        continue;
      }
      result.hits.push({
        name: match[0],
        line: row + 1,
        column: match.index + 1,
        endColumn: match.index + match[0].length + 1,
        ...verdict,
      });
    }
  }
  return result;
}

type Shape = Omit<Hit, 'name' | 'line' | 'column' | 'endColumn'>;

function classify(node: Node, word: string): Shape | SkipReason {
  if (!NAME_NODES.has(node.type) || node.text !== word) return 'not-code';
  const parent = node.parent;
  if (parent === null) return 'not-code';
  const field = fieldOf(node);

  if (ancestor(node, (n) => IMPORT_STATEMENTS.has(n.type)) !== null) return 'import';
  // `export { a as b }`, `export { a } from '…'`, `export default a;`: module level (ADR 0001).
  if (ancestor(node, (n) => n.type === 'export_clause') !== null) return 'import';
  if (parent.type === 'export_statement' && field === 'value') return 'import';

  if (field === 'name' && DECLARING_PARENTS.has(parent.type)) return 'declaration';
  if (field === 'pattern' && /parameter$/.test(parent.type)) return 'declaration';
  if (field === 'property' && parent.type === 'field_definition') return 'declaration';
  if (PARAMETER_LISTS.has(parent.type) && node.type === 'identifier') return 'declaration';
  if (node.type === 'shorthand_property_identifier_pattern') return 'declaration';
  if (field === 'parameter' && parent.type === 'arrow_function') return 'declaration';
  if (field === 'key' && (parent.type === 'pair' || parent.type === 'pair_pattern')) return 'key';
  if (field === 'name' && parent.type === 'keyword_argument') return 'key';

  let call = false;
  let receiver: Node | null = null;
  let chaining: Shape['chaining'] = null;
  const grand = parent.parent;
  const member =
    (parent.type === 'member_expression' && field === 'property') ||
    (parent.type === 'attribute' && field === 'attribute') ||
    (parent.type === 'field_access' && field === 'field');
  if (member) {
    receiver = parent.childForFieldName('object');
    call =
      grand !== null &&
      ['call_expression', 'call', 'new_expression'].includes(grand.type) &&
      isField(parent, grand.type === 'new_expression' ? 'constructor' : 'function');
    if (word === '__init__' && call && receiver?.type === 'call') chaining = 'super';
  } else if (parent.type === 'method_invocation' && field === 'name') {
    call = true;
    receiver = parent.childForFieldName('object');
  } else if (
    (parent.type === 'call_expression' && field === 'function') ||
    (parent.type === 'call' && field === 'function') ||
    (parent.type === 'new_expression' && field === 'constructor')
  ) {
    call = true;
  } else if (parent.type === 'explicit_constructor_invocation' && field === 'constructor') {
    call = true;
  } else if (isCreatedType(node)) {
    call = true;
  }
  if (node.type === 'super' || node.type === 'this') {
    // Only `super(…)` / `this(…)` chain constructors; `super.m()` and `this.x` do not.
    if (!call || receiver !== null) return 'not-code';
    chaining = node.type;
  }

  return {
    call,
    receiver: receiver?.text ?? null,
    simpleReceiver: receiver !== null && receiver.type === 'identifier',
    heritage: ancestor(node, (n) => HERITAGE.has(n.type) || isPythonBases(n), 4) !== null,
    chaining,
    enclosingClass: enclosingClass(node),
  };
}

/** Java `new C(…)`, `new C<T>(…)`, `new a.b.C(…)`: the created type is a call site. */
function isCreatedType(node: Node): boolean {
  let n: Node = node;
  while (n.parent && ['generic_type', 'scoped_type_identifier'].includes(n.parent.type)) {
    n = n.parent;
  }
  return n.parent?.type === 'object_creation_expression' && isField(n, 'type');
}

function isPythonBases(node: Node): boolean {
  return node.type === 'argument_list' && node.parent?.type === 'class_definition';
}

function enclosingClass(node: Node): Hit['enclosingClass'] {
  const cls = ancestor(node, (n) => CLASS_NODES.has(n.type));
  if (cls === null) return null;
  const name = cls.childForFieldName('name')?.text;
  if (name === undefined) return null;
  return { name, bases: baseNames(cls) };
}

/** The last segment of each direct base class and interface of a class node. */
export function baseNames(cls: Node): string[] {
  const lists = cls.children.filter(
    (c): c is Node =>
      c !== null &&
      (HERITAGE.has(c.type) || (c.type === 'argument_list' && isField(c, 'superclasses'))),
  );
  const names: string[] = [];
  const visit = (n: Node) => {
    if (['identifier', 'type_identifier'].includes(n.type)) {
      names.push(n.text);
      return;
    }
    // `a.B`, `a.b.C`: only the last segment names the class. Type arguments are skipped.
    if (
      [
        'member_expression',
        'attribute',
        'scoped_type_identifier',
        'nested_type_identifier',
      ].includes(n.type)
    ) {
      const last = n.namedChildren.at(-1);
      if (last) names.push(last.text);
      return;
    }
    if (['type_arguments', 'keyword_argument'].includes(n.type)) return;
    for (const c of n.namedChildren) if (c) visit(c);
  };
  for (const list of lists) visit(list);
  return names;
}

function fieldOf(node: Node): string | null {
  const parent = node.parent;
  if (parent === null) return null;
  for (let i = 0; i < parent.childCount; i++) {
    if (parent.child(i)?.id === node.id) return parent.fieldNameForChild(i);
  }
  return null;
}

function isField(node: Node, field: string): boolean {
  return fieldOf(node) === field;
}

function ancestor(node: Node, test: (n: Node) => boolean, maxDepth = Infinity): Node | null {
  let depth = 0;
  for (let n = node.parent; n && depth < maxDepth; n = n.parent, depth++) {
    if (test(n)) return n;
  }
  return null;
}
