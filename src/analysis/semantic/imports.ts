// Import-path resolution (#17, pipeline step 4; #42 "Pipeline changes" 4): what a name in a file
// refers to, from the file's own imports and declarations, following re-exports up to
// MAX_REEXPORT_DEPTH levels. It settles a bare-name hit (`formatPrice(…)`) or a module-attribute
// hit (`t.tax(…)`) as the changed entity or not, and finds the aliases a changed entity is
// imported under (`import { fmt } from './reexport'`), which candidate search then adds.
//
// Only what the files say is used: relative TS/JS specifiers, Python modules under the
// repository root or `src/`, Java imports and packages. Package imports, path aliases, CommonJS
// `require` and anything else not understood resolve to null ("unknown"), never to "no".
import { posix } from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { Side } from '../../schemas/common.ts';
import { extractFacts, type Entity } from '../structural/entities.ts';
import type { GrammarName } from '../structural/languages.ts';
import { freeTrees, type ParsedFile, type StructuralParser } from '../structural/parser.ts';
import type { Hit } from './hits.ts';
import type { SnapshotFiles } from './snapshot-files.ts';

/** Re-exports followed from the imported module before giving up (#17). */
export const MAX_REEXPORT_DEPTH = 3;

/** Languages that can refer to each other's names. */
export type Family = 'js' | 'python' | 'java';

export function familyOf(grammar: GrammarName): Family {
  return grammar === 'python' ? 'python' : grammar === 'java' ? 'java' : 'js';
}

/** What an imported name is bound to: a name exported by a module, or the module itself. */
export type Binding =
  { kind: 'named'; module: string; name: string } | { kind: 'namespace'; module: string };

/** The import-relevant facts of one file side. Plain data: the tree can be freed. */
export interface ModuleInfo {
  family: Family;
  /** Names of top-level entities (functions, classes, …): definitions in this file. */
  definitions: Set<string>;
  /** Other top-level names (variables): what they hold is not known. */
  variables: Set<string>;
  bindings: Map<string, Binding>;
  /** JS/TS: exported name → the local name, or the name in another module. `*` is the module. */
  exports: Map<string, { module: string | null; name: string }>;
  /** `export * from`, Python `from m import *`. */
  stars: string[];
  /** JS/TS: has an import or export, so its names are not global script names. */
  isModule: boolean;
  /** Uses `require(…)` or dynamic `import(…)`, whose bindings are not modelled. */
  opaque: boolean;
  /** Java: the package, imports and every declared type name. */
  javaPackage: string | null;
  javaImports: { path: string; static: boolean; wildcard: boolean }[];
  javaTypes: Set<string>;
}

export type Resolved =
  { kind: 'definition'; path: string; name: string } | { kind: 'module'; path: string };

/** What import resolution needs to know about a changed entity on one side. */
export interface TargetKey {
  family: Family;
  path: string;
  kind: Entity['kind'];
  /** The top-level definition it is (a function, a class) or, for a constructor, its class. */
  definition: string | null;
  /** For a method of a top-level class: the class. */
  owner: string | null;
  /** Nested in a function or namespace: reachable by a bare name only from its own file. */
  nested: boolean;
  /** Java: the fully qualified class it is, or its class for constructors and methods. */
  javaClass: string | null;
  name: string;
}

export interface Decision {
  verdict: 'yes' | 'no';
  detail: string;
}

export function moduleInfo(file: ParsedFile, entities: Entity[]): ModuleInfo {
  const family = familyOf(file.language);
  const root = file.tree.rootNode;
  const info: ModuleInfo = {
    family,
    definitions: new Set(entities.filter((e) => e.container === null).map((e) => e.name)),
    variables: new Set(),
    bindings: new Map(),
    exports: new Map(),
    stars: [],
    isModule: false,
    opaque: false,
    javaPackage: null,
    javaImports: [],
    javaTypes: new Set(),
  };
  if (family === 'js') jsModule(root, info);
  else if (family === 'python') pythonModule(root, info);
  else javaModule(root, entities, info);
  for (const name of info.definitions) info.variables.delete(name);
  return info;
}

function jsModule(root: Node, info: ModuleInfo): void {
  info.opaque = /\brequire\s*\(|\bimport\s*\(/.test(root.text);
  for (const statement of root.namedChildren) {
    if (statement === null) continue;
    if (statement.type === 'import_statement') {
      info.isModule = true;
      const module = stringValue(statement.childForFieldName('source'));
      const clause = statement.namedChildren.find((c) => c?.type === 'import_clause');
      if (module === null || !clause) continue;
      for (const part of clause.namedChildren) {
        if (part?.type === 'identifier') {
          info.bindings.set(part.text, { kind: 'named', module, name: 'default' });
        } else if (part?.type === 'namespace_import') {
          const local = part.namedChildren.find((c) => c?.type === 'identifier');
          if (local) info.bindings.set(local.text, { kind: 'namespace', module });
        } else if (part?.type === 'named_imports') {
          for (const spec of part.namedChildren) {
            if (spec?.type !== 'import_specifier') continue;
            const name = spec.childForFieldName('name')?.text;
            const alias = spec.childForFieldName('alias')?.text ?? name;
            if (name && alias) info.bindings.set(alias, { kind: 'named', module, name });
          }
        }
      }
    } else if (statement.type === 'export_statement') {
      info.isModule = true;
      jsExport(statement, info);
    } else if (['lexical_declaration', 'variable_declaration'].includes(statement.type)) {
      jsVariables(statement, info);
    }
  }
}

function jsExport(statement: Node, info: ModuleInfo): void {
  const module = stringValue(statement.childForFieldName('source'));
  const clause = statement.namedChildren.find((c) => c?.type === 'export_clause');
  if (clause) {
    for (const spec of clause.namedChildren) {
      if (spec?.type !== 'export_specifier') continue;
      const name = spec.childForFieldName('name')?.text;
      const alias = spec.childForFieldName('alias')?.text ?? name;
      if (name && alias) info.exports.set(alias, { module, name });
    }
    return;
  }
  const namespace = statement.namedChildren.find((c) => c?.type === 'namespace_export');
  if (module !== null && namespace) {
    const local = namespace.namedChildren.at(-1);
    if (local) info.exports.set(local.text, { module, name: '*' });
    return;
  }
  if (module !== null) {
    info.stars.push(module);
    return;
  }
  const value = statement.childForFieldName('value');
  if (value?.type === 'identifier') info.exports.set('default', { module: null, name: value.text });
  const declaration = statement.childForFieldName('declaration') ?? value;
  const declared = declaration?.childForFieldName('name')?.text;
  if (declared && statement.children.some((c) => c?.type === 'default')) {
    info.exports.set('default', { module: null, name: declared });
  }
  if (declaration && ['lexical_declaration', 'variable_declaration'].includes(declaration.type)) {
    jsVariables(declaration, info);
  }
}

function jsVariables(declaration: Node, info: ModuleInfo): void {
  for (const d of declaration.namedChildren) {
    const name = d?.type === 'variable_declarator' ? d.childForFieldName('name') : null;
    if (name?.type === 'identifier') info.variables.add(name.text);
  }
}

function pythonModule(root: Node, info: ModuleInfo): void {
  info.isModule = true;
  // Imports anywhere in the file count: a function-level import still binds the name there.
  for (const statement of root.descendantsOfType(['import_statement', 'import_from_statement'])) {
    if (statement === null) continue;
    const names = childrenForField(statement, 'name');
    if (statement.type === 'import_statement') {
      for (const name of names) {
        if (name.type === 'aliased_import') {
          const module = name.childForFieldName('name')?.text;
          const alias = name.childForFieldName('alias')?.text;
          if (module && alias) info.bindings.set(alias, { kind: 'namespace', module });
        } else {
          // `import a.b` binds `a`.
          const first = name.text.split('.')[0]!;
          info.bindings.set(first, { kind: 'namespace', module: first });
        }
      }
      continue;
    }
    const module = statement.childForFieldName('module_name')?.text;
    if (!module) continue;
    if (statement.namedChildren.some((c) => c?.type === 'wildcard_import')) info.stars.push(module);
    for (const name of names) {
      const [imported, alias] =
        name.type === 'aliased_import'
          ? [name.childForFieldName('name')?.text, name.childForFieldName('alias')?.text]
          : [name.text, name.text];
      if (imported && alias) info.bindings.set(alias, { kind: 'named', module, name: imported });
    }
  }
  for (const statement of root.namedChildren) {
    const assignment = statement?.type === 'expression_statement' ? statement.namedChild(0) : null;
    const left = assignment?.type === 'assignment' ? assignment.childForFieldName('left') : null;
    if (left?.type === 'identifier') info.variables.add(left.text);
  }
}

function javaModule(root: Node, entities: Entity[], info: ModuleInfo): void {
  for (const statement of root.namedChildren) {
    if (statement?.type === 'package_declaration') {
      info.javaPackage =
        statement.namedChildren.find((c) => c?.type !== 'annotation')?.text ?? null;
    } else if (statement?.type === 'import_declaration') {
      const path = statement.namedChildren.find(
        (c) => c?.type === 'scoped_identifier' || c?.type === 'identifier',
      )?.text;
      if (!path) continue;
      info.javaImports.push({
        path,
        static: statement.children.some((c) => c?.type === 'static'),
        wildcard: statement.namedChildren.some((c) => c?.type === 'asterisk'),
      });
    }
  }
  for (const e of entities) {
    if (['class', 'interface', 'enum'].includes(e.kind)) info.javaTypes.add(e.name);
  }
}

function stringValue(node: Node | null): string | null {
  if (node === null) return null;
  const fragment = node.namedChildren.find((c) => c?.type === 'string_fragment');
  return fragment?.text ?? (node.text.length >= 2 ? node.text.slice(1, -1) : null);
}

function childrenForField(node: Node, field: string): Node[] {
  const out: Node[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && node.fieldNameForChild(i) === field) out.push(child);
  }
  return out;
}

const JS_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
/** TS lets `./x.js` name `./x.ts`. */
const JS_SOURCE_FOR: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};
/** Where absolute Python imports are looked up: the repository root and a `src/` layout. */
const PYTHON_ROOTS = ['', 'src/'];

/** Resolves names across files of one snapshot side, reading and parsing files on demand. */
export class Resolver {
  readonly #files: SnapshotFiles;
  readonly #parser: StructuralParser;
  readonly #infos = new Map<string, Promise<ModuleInfo | null>>();
  readonly #modules = new Map<string, Promise<string | null>>();

  constructor(files: SnapshotFiles, parser: StructuralParser) {
    this.#files = files;
    this.#parser = parser;
  }

  /** Registers what the caller already parsed, so the file is not parsed twice. */
  remember(side: Side, path: string, info: ModuleInfo): void {
    this.#infos.set(`${side}:${path}`, Promise.resolve(info));
  }

  info(side: Side, path: string): Promise<ModuleInfo | null> {
    const key = `${side}:${path}`;
    let info = this.#infos.get(key);
    if (info === undefined) {
      info = this.#load(side, path);
      this.#infos.set(key, info);
    }
    return info;
  }

  async #load(side: Side, path: string): Promise<ModuleInfo | null> {
    const source = await this.#files.read(side, path);
    if (source === null) return null;
    const parsed = await this.#parser.parse(path, source);
    if (parsed.status !== 'parsed') return null;
    try {
      return moduleInfo(parsed, extractFacts(parsed).entities);
    } finally {
      freeTrees(parsed);
    }
  }

  /** The file a module specifier in `from` names, or null when it cannot be found. */
  resolveModule(
    side: Side,
    from: string,
    specifier: string,
    family: Family,
  ): Promise<string | null> {
    const key = `${side}:${from}:${family}:${specifier}`;
    let path = this.#modules.get(key);
    if (path === undefined) {
      path = this.#firstExisting(side, moduleCandidates(from, specifier, family));
      this.#modules.set(key, path);
    }
    return path;
  }

  async #firstExisting(side: Side, candidates: string[]): Promise<string | null> {
    for (const candidate of candidates) {
      if ((await this.#files.read(side, candidate)) !== null) return candidate;
    }
    return null;
  }

  /**
   * What `name` exported by the file at `path` is, following re-exports. `depth` counts the
   * modules entered: the one a file imports is 1, and each re-export adds one.
   */
  async resolveExport(side: Side, path: string, name: string, depth = 1): Promise<Resolved | null> {
    if (depth > 1 + MAX_REEXPORT_DEPTH) return null;
    const info = await this.info(side, path);
    if (info === null) return null;
    let local = name;
    if (info.family === 'js') {
      const exported = info.exports.get(name);
      if (exported?.module != null) {
        const module = await this.resolveModule(side, path, exported.module, info.family);
        if (module === null) return null;
        if (exported.name === '*') return { kind: 'module', path: module };
        return this.resolveExport(side, module, exported.name, depth + 1);
      }
      if (exported) local = exported.name;
    }
    return this.resolveLocal(side, path, info, local, depth);
  }

  /** What a name used in the file at `path` is: its own definition, an import, or unknown. */
  async resolveLocal(
    side: Side,
    path: string,
    info: ModuleInfo,
    name: string,
    depth = 0,
  ): Promise<Resolved | null> {
    if (info.definitions.has(name)) return { kind: 'definition', path, name };
    if (info.variables.has(name)) return null;
    const binding = info.bindings.get(name);
    if (binding) return this.resolveBinding(side, path, info.family, binding, depth + 1);
    for (const star of info.stars) {
      const module = await this.resolveModule(side, path, star, info.family);
      const found =
        module === null ? null : await this.resolveExport(side, module, name, depth + 1);
      if (found) return found;
    }
    return null;
  }

  /** What an import binding in the file at `from` is; `depth` as in `resolveExport()`. */
  async resolveBinding(
    side: Side,
    from: string,
    family: Family,
    binding: Binding,
    depth = 1,
  ): Promise<Resolved | null> {
    const module = await this.resolveModule(side, from, binding.module, family);
    if (module === null) return null;
    if (binding.kind === 'namespace') return { kind: 'module', path: module };
    const found = await this.resolveExport(side, module, binding.name, depth);
    if (found || family !== 'python') return found;
    // `from pkg import mod` imports a submodule when `pkg` defines no such name.
    const submodule = await this.resolveModule(
      side,
      from,
      pythonJoin(binding.module, binding.name),
      family,
    );
    return submodule === null ? null : { kind: 'module', path: submodule };
  }

  /**
   * Whether a hit in the file at `path` refers to the target (#42 step 4). Null when the files
   * do not say. For constructor roots the caller passes call sites only.
   */
  async decide(
    side: Side,
    path: string,
    info: ModuleInfo,
    hit: Hit,
    target: TargetKey,
  ): Promise<Decision | null> {
    if (info.family === 'java') return decideJava(info, path, hit, target);

    if (hit.receiver === null) {
      if (target.nested && path === target.path) return null;
      const known =
        info.definitions.has(hit.name) ||
        info.variables.has(hit.name) ||
        info.bindings.has(hit.name) ||
        info.stars.length > 0;
      if (known) {
        const resolved = await this.resolveLocal(side, path, info, hit.name);
        return resolved === null ? null : compare(resolved, target, hit.name);
      }
      if (info.opaque || (info.family === 'js' && !info.isModule)) return null;
      return { verdict: 'no', detail: `${hit.name} is neither imported nor defined in this file` };
    }

    if (!hit.simpleReceiver) return null;
    const owner = await this.resolveLocal(side, path, info, hit.receiver);
    if (owner?.kind === 'module') {
      const member = await this.resolveExport(side, owner.path, hit.name, 1);
      if (member === null) return null;
      const decision = compare(member, target, hit.name);
      return { ...decision, detail: `${hit.receiver} is ${owner.path}; ${decision.detail}` };
    }
    // `Fmt.formatPrice`: a member of a class this file imports or defines.
    if (
      owner?.kind === 'definition' &&
      target.owner === owner.name &&
      target.path === owner.path &&
      hit.name === target.name
    ) {
      return { verdict: 'yes', detail: `${hit.receiver} is ${owner.path}::${owner.name}` };
    }
    return null;
  }
}

function compare(resolved: Resolved, target: TargetKey, name: string): Decision {
  if (resolved.kind === 'module') {
    return { verdict: 'no', detail: `${name} is the module ${resolved.path}` };
  }
  const where = `${resolved.path}::${resolved.name}`;
  if (resolved.path === target.path && resolved.name === target.definition) {
    return { verdict: 'yes', detail: `${name} resolves to ${where}` };
  }
  return { verdict: 'no', detail: `${name} resolves to ${where}, a different definition` };
}

function decideJava(info: ModuleInfo, path: string, hit: Hit, target: TargetKey): Decision | null {
  const javaClass = target.javaClass;
  if (javaClass === null) return null;
  const simple = lastSegment(javaClass);
  /**
   * The class a simple type name is in this file: a type it declares itself (the target only in
   * the target's own file), a single-type import, else its own package (which Java searches
   * before `.*` imports). A same-package guess can be wrong, so only the first two say "no".
   */
  const classOf = (name: string): { fqn: string; certain: boolean } | null => {
    if (info.javaTypes.has(name)) {
      return { fqn: path === target.path ? javaClass : `${path}::${name}`, certain: true };
    }
    const imported = info.javaImports.find(
      (i) => !i.static && !i.wildcard && lastSegment(i.path) === name,
    );
    if (imported) return { fqn: imported.path, certain: true };
    if (info.javaPackage === null) return null;
    return { fqn: `${info.javaPackage}.${name}`, certain: false };
  };

  if (target.kind === 'method' && hit.receiver === null) {
    const imported = info.javaImports.find(
      (i) => i.static && !i.wildcard && lastSegment(i.path) === hit.name,
    );
    if (!imported) return null;
    return imported.path === `${javaClass}.${target.name}`
      ? { verdict: 'yes', detail: `static import ${imported.path}` }
      : { verdict: 'no', detail: `static import ${imported.path}, a different method` };
  }
  // A class name: the hit itself for types and constructors, the receiver of a static call.
  const name = target.kind === 'method' ? hit.receiver : hit.receiver === null ? hit.name : null;
  if (name !== simple || (target.kind === 'method' && !hit.simpleReceiver)) return null;
  const owner = classOf(name);
  if (owner === null) return null;
  if (owner.fqn === javaClass) return { verdict: 'yes', detail: `${name} is ${owner.fqn}` };
  if (!owner.certain || target.kind === 'method') return null;
  return { verdict: 'no', detail: `${name} is ${owner.fqn}, a different class` };
}

function moduleCandidates(from: string, specifier: string, family: Family): string[] {
  if (family === 'js') {
    if (!specifier.startsWith('.')) return [];
    const base = posix.normalize(posix.join(posix.dirname(from), specifier));
    if (base.startsWith('..')) return [];
    const ext = posix.extname(base);
    const swapped = (JS_SOURCE_FOR[ext] ?? []).map((e) => base.slice(0, -ext.length) + e);
    return [
      ...swapped,
      base,
      ...JS_EXTENSIONS.map((e) => base + e),
      ...JS_EXTENSIONS.map((e) => `${base}/index${e}`),
    ];
  }
  if (family !== 'python') return [];
  const dots = /^\.*/.exec(specifier)![0].length;
  const rest = specifier.slice(dots).split('.').filter(Boolean).join('/');
  let bases: string[];
  if (dots > 0) {
    let dir = posix.dirname(from);
    for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
    if (!rest) return [dir === '.' ? '__init__.py' : `${dir}/__init__.py`];
    bases = [dir === '.' ? rest : `${dir}/${rest}`];
  } else {
    if (!rest) return [];
    bases = PYTHON_ROOTS.map((root) => root + rest);
  }
  return bases.flatMap((b) => [`${b}.py`, `${b}.pyi`, `${b}/__init__.py`]);
}

function pythonJoin(module: string, name: string): string {
  return /\.$/.test(module) ? module + name : `${module}.${name}`;
}

function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf('.') + 1);
}
