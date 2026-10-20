// The semantic analyzer (#17, design reference §8.4, §9.4): how the changed entities relate to
// each other. Reads a ChangeSet and its StructuralChangeSet and produces SemanticEvidence.
//
// Only relationships between changed entities are searched for (MVP spec D12): hits of a
// changed name inside other changed entities, on the old side and the new side. The pipeline,
// in the order #42 settled:
//   1. text search for each changed name, and for the aliases it is imported under;
//   2. the tree-sitter filter: skip comments, strings, declarations, keys and import lines, and
//      map each hit to its innermost entity, keeping it only when that entity is changed;
//   3. the unambiguous rule: a plain call of a name with one definition is accepted as is;
//   4. import-path resolution decides the rest where the files say (imports.ts);
//   5. a language server, when one is given, confirms or rejects new-side candidates;
//   6. old-side candidates no new-side hit stands for (removed calls, and pairs the new-side
//      server rejected) go to a base-side server, started only then (#66); a new-side rejection
//      is carried over to the matching old-side hit that server did not decide;
//   7. test files keep one hit per side for each (test file, changed entity) (D2).
// AI adjudication of what is left (#43) is not part of this module.
//
// Every hit is a `text-search` candidate record. Import resolution and LSP add their own record
// with outcome `confirmed` or `rejected`; only LSP's can make an edge `verified` (invariant 4).
import type { ChangeSet, FileChange } from '../../schemas/changeset.ts';
import type { Side, SourceRange } from '../../schemas/common.ts';
import { stableId } from '../../schemas/ids.ts';
import {
  SEMANTIC_SCHEMA_VERSION,
  SemanticEvidence,
  type CodeRelation,
  type EvidenceRecord,
  type FanOutCap,
  type LanguageCapability,
} from '../../schemas/semantic.ts';
import type { AnalyzedFile, ChangedEntity, StructuralChangeSet } from '../../schemas/structural.ts';
import { extractFacts, type Entity } from '../structural/entities.ts';
import { detectLanguage, type GrammarName } from '../structural/languages.ts';
import {
  declarations,
  freeTrees,
  StructuralParser,
  type Declaration,
  type ParsedFile,
} from '../structural/parser.ts';
import { baseNames, CLASS_NODES, findHits, type Hit } from './hits.ts';
import {
  familyOf,
  moduleInfo,
  Resolver,
  type Decision,
  type Family,
  type ModuleInfo,
  type TargetKey,
} from './imports.ts';
import { rangeContains } from './normalise.ts';
import type { LspSession, ProjectHealth, SessionCapability } from './session.ts';
import { changeSetFiles, type SnapshotFiles } from './snapshot-files.ts';

/** Source entities kept per (changed entity, relation); the rest is reported as a cap (D1). */
export const MAX_CANDIDATES_PER_ENTITY = 100;
/** Files parsed to count a name's definitions; beyond this the name counts as ambiguous. */
const MAX_DEFINITION_FILES = 200;

/** The part of `LspSession` the analyzer uses. Tests pass a fake. */
export type ReferenceProvider = Pick<LspSession, 'references' | 'projectHealth' | 'capabilities'>;

export interface SemanticOptions {
  /** The whole snapshot, for imports and definitions outside the change. Default: changed files only. */
  files?: SnapshotFiles;
  /** A session started on the new side's working tree. Without one, nothing is verified. */
  lsp?: ReferenceProvider;
  /**
   * Starts a session on the old side's working tree for these languages. Called at most once,
   * and only when old-side candidates need it; the caller closes the session. Needs `lsp`.
   */
  oldLsp?: (languages: string[]) => Promise<ReferenceProvider>;
  maxCandidatesPerEntity?: number;
}

/** One side of a changed file the structural analyzer could parse. */
interface SideFile {
  side: Side;
  /** The path on this side. */
  path: string;
  /** `AnalyzedFile.path`: what the graph and test-file edges use. */
  filePath: string;
  grammar: GrammarName;
  family: Family;
  content: string;
  entities: Entity[];
  info: ModuleInfo;
  test: boolean;
  changed: Map<Entity, ChangedEntity>;
  module: ChangedEntity | null;
}

/** A changed entity whose name is searched for. */
interface Target {
  entity: ChangedEntity;
  order: number;
  family: Family;
  sides: Partial<Record<Side, TargetSide>>;
}

/** A target on one side. */
interface TargetSide {
  path: string;
  search: string;
  key: TargetKey;
  /** The grammar and the name's position, for `references`. */
  lsp: { language: string; line: number; column: number } | null;
  /** A method of a class with bases: calls through a base type are not in its references. */
  mayOverride: boolean;
}

interface Pair {
  target: Target;
  source: ChangedEntity;
  file: SideFile;
  hit: Hit;
  relation: CodeRelation;
  notes: string[];
  imports: Decision | null;
  lsp: { outcome: 'confirmed' | 'rejected'; detail: string } | null;
}

export async function analyzeSemantics(
  changeSet: ChangeSet,
  structure: StructuralChangeSet,
  options: SemanticOptions = {},
): Promise<SemanticEvidence> {
  const files = options.files ?? changeSetFiles(changeSet);
  const parser = new StructuralParser();
  try {
    const resolver = new Resolver(files, parser);
    const { sideFiles, targets } = await prepare(changeSet, structure, parser, resolver);
    const definitions = new DefinitionCounter(files, parser, sideFiles);

    let pairs: Pair[] = [];
    for (const file of sideFiles) {
      pairs.push(...(await searchFile(file, targets, parser, resolver, definitions)));
    }
    pairs.sort(
      (a, b) =>
        a.target.order - b.target.order ||
        sideOrder(a.file.side) - sideOrder(b.file.side) ||
        a.file.path.localeCompare(b.file.path) ||
        a.hit.line - b.hit.line ||
        a.hit.column - b.hit.column,
    );
    let languages: LanguageCapability[] = withoutServers(structure.files);
    if (options.lsp) {
      await verify(pairs, 'new', options.lsp);
      languages = withSide(options.lsp.capabilities(), 'new');
      const old = needOldSide(pairs);
      const needed = [...new Set(old.map((p) => p.target.sides.old!.lsp!.language))];
      if (options.oldLsp && needed.length > 0) {
        const oldLsp = await options.oldLsp(needed);
        await verify(old, 'old', oldLsp);
        languages.push(...withSide(oldLsp.capabilities(), 'old'));
      }
      carryOverRejections(pairs);
    }
    pairs = collapseTestFiles(pairs);
    const { kept, caps } = applyCaps(
      pairs,
      options.maxCandidatesPerEntity ?? MAX_CANDIDATES_PER_ENTITY,
    );

    return SemanticEvidence.parse({
      schemaVersion: SEMANTIC_SCHEMA_VERSION,
      snapshotId: changeSet.snapshotId,
      languages,
      records: kept.flatMap(records),
      caps,
    });
  } finally {
    parser.delete();
  }
}

// ---------------------------------------------------------------------------------------------
// Preparation: entities of each changed file side, and the targets

async function prepare(
  changeSet: ChangeSet,
  structure: StructuralChangeSet,
  parser: StructuralParser,
  resolver: Resolver,
): Promise<{ sideFiles: SideFile[]; targets: Target[] }> {
  const sideFiles: SideFile[] = [];
  const targets = new Map<string, Target>();
  const named = structure.entities.filter((e) => e.kind !== 'module' && e.name !== null);

  for (const [index, change] of changeSet.files.entries()) {
    const analysed = structure.files[index];
    if (!analysed || analysed.language === null || analysed.skipped !== null) continue;
    for (const side of ['old', 'new'] as const) {
      const path = side === 'old' ? change.oldPath : change.newPath;
      const content = side === 'old' ? change.oldContent : change.newContent;
      const grammar = path === null ? null : detectLanguage(path);
      if (path === null || content === null || grammar === null) continue;
      const parsed = await parser.parse(path, content);
      if (parsed.status !== 'parsed') continue;
      try {
        const { entities } = extractFacts(parsed);
        const info = moduleInfo(parsed, entities);
        resolver.remember(side, path, info);
        const file: SideFile = {
          side,
          path,
          filePath: analysed.path,
          grammar,
          family: familyOf(grammar),
          content,
          entities,
          info,
          test: analysed.test !== null,
          changed: new Map(),
          module: moduleEntity(structure, change, side),
        };
        for (const entity of named) {
          const range = side === 'old' ? entity.oldRange : entity.newRange;
          const entityPath = side === 'old' ? (entity.oldPath ?? entity.path) : entity.path;
          if (range === null || entityPath !== path) continue;
          const facts = entities.find((e) => e.kind === entity.kind && sameRange(e.range, range));
          if (!facts) continue;
          file.changed.set(facts, entity);
          const target = targets.get(entity.id) ?? {
            entity,
            order: structure.entities.indexOf(entity),
            family: file.family,
            sides: {},
          };
          targets.set(entity.id, target);
          const search = entity.kind === 'constructor' ? lastSegment(facts.container) : facts.name;
          if (search === null) continue;
          target.sides[side] = {
            path,
            search,
            key: targetKey(file, facts),
            ...lspTarget(parsed, facts, search, grammar),
          };
        }
        sideFiles.push(file);
      } finally {
        freeTrees(parsed);
      }
    }
  }
  return { sideFiles, targets: [...targets.values()].sort((a, b) => a.order - b.order) };
}

function moduleEntity(
  structure: StructuralChangeSet,
  change: FileChange,
  side: Side,
): ChangedEntity | null {
  const path = change.newPath ?? change.oldPath;
  const module = structure.entities.find((e) => e.kind === 'module' && e.path === path);
  if (!module) return null;
  if ((side === 'old' && change.oldPath === null) || (side === 'new' && change.newPath === null)) {
    return null;
  }
  return module;
}

function targetKey(file: SideFile, facts: Entity): TargetKey {
  const { kind, name, container } = facts;
  const topLevelContainer = container !== null && !container.includes('.') ? container : null;
  let javaClass: string | null = null;
  if (file.family === 'java') {
    const chain = ['class', 'interface', 'enum'].includes(kind)
      ? container === null
        ? name
        : `${container}.${name}`
      : container;
    if (chain !== null) {
      javaClass = file.info.javaPackage === null ? chain : `${file.info.javaPackage}.${chain}`;
    }
  }
  return {
    family: file.family,
    path: file.path,
    kind,
    name,
    definition:
      container === null && kind !== 'method'
        ? name
        : kind === 'constructor'
          ? topLevelContainer
          : null,
    owner: kind === 'method' ? topLevelContainer : null,
    nested: container !== null && kind !== 'method' && kind !== 'constructor',
    javaClass,
  };
}

/**
 * Where to ask a language server about a target: its name, or for a constructor its class name
 * (#16). Also whether a method's class has bases it may override.
 */
function lspTarget(
  parsed: ParsedFile,
  facts: Entity,
  search: string,
  grammar: GrammarName,
): Pick<TargetSide, 'lsp' | 'mayOverride'> {
  const constructor = facts.kind === 'constructor';
  const inside = (d: Declaration) =>
    constructor
      ? d.kind === 'class' && d.name === search && startsIn(d.range, facts.range)
      : d.kind === facts.kind && d.name === facts.name && within(d.range, facts.range);
  const declaration = declarations(parsed).find(inside);
  if (!declaration) return { lsp: null, mayOverride: false };
  let mayOverride = false;
  if (facts.kind === 'method') {
    for (let n = declaration.node.parent; n; n = n.parent) {
      if (CLASS_NODES.has(n.type)) {
        mayOverride = baseNames(n).length > 0;
        break;
      }
    }
  }
  const at = declaration.nameRange;
  return {
    lsp: { language: grammar, line: at.startLine, column: at.startColumn ?? 1 },
    mayOverride,
  };
}

// ---------------------------------------------------------------------------------------------
// Steps 1-4: search one file side, filter, and decide what the files can

async function searchFile(
  file: SideFile,
  targets: Target[],
  parser: StructuralParser,
  resolver: Resolver,
  definitions: DefinitionCounter,
): Promise<Pair[]> {
  const mine = targets.filter((t) => t.family === file.family && t.sides[file.side]);
  if (mine.length === 0) return [];
  const byName = new Map<string, Target[]>();
  const add = (map: Map<string, Target[]>, name: string, target: Target) => {
    const list = map.get(name) ?? [];
    if (!list.includes(target)) list.push(target);
    map.set(name, list);
  };
  for (const t of mine) add(byName, t.sides[file.side]!.search, t);

  // Aliases: a binding in this file that resolves to a target under another name (#17).
  const aliases = new Map<string, Target[]>();
  for (const [local, binding] of file.info.bindings) {
    if (binding.kind !== 'named') continue;
    const resolved = await resolver.resolveBinding(file.side, file.path, file.family, binding);
    if (resolved?.kind !== 'definition') continue;
    for (const t of mine) {
      const s = t.sides[file.side]!;
      if (
        s.key.path === resolved.path &&
        s.key.definition === resolved.name &&
        local !== s.search
      ) {
        add(aliases, local, t);
      }
    }
  }

  const constructors = mine.filter((t) => t.entity.kind === 'constructor');
  const words = [...byName.keys(), ...aliases.keys()];
  if (constructors.length > 0) {
    words.push(...(file.family === 'python' ? ['__init__'] : ['super']));
    if (file.family === 'java') words.push('this');
  }

  const parsed = await parser.parse(file.path, file.content);
  if (parsed.status !== 'parsed') return [];
  let hits: Hit[];
  try {
    hits = findHits(parsed, file.content, words).hits;
  } finally {
    freeTrees(parsed);
  }

  const pairs: Pair[] = [];
  for (const hit of hits) {
    const source = enclosing(file, hit);
    if (source === null) continue;
    let matched: Target[];
    if (hit.chaining === 'super') {
      const bases = hit.enclosingClass?.bases ?? [];
      matched = constructors.filter((t) => bases.includes(t.sides[file.side]!.search));
    } else if (hit.chaining === 'this') {
      matched = constructors.filter(
        (t) =>
          t.sides[file.side]!.path === file.path &&
          t.sides[file.side]!.search === hit.enclosingClass?.name,
      );
    } else {
      matched = [...(byName.get(hit.name) ?? []), ...(aliases.get(hit.name) ?? [])];
    }
    for (const target of matched) {
      if (target.entity.id === source.id) continue;
      const constructor = target.entity.kind === 'constructor';
      // For constructor roots only call sites count (#42): not types, `isinstance`, imports.
      if (constructor && !hit.call) continue;
      const pair = await decidePair(file, target, source, hit, resolver, definitions);
      pairs.push(pair);
    }
  }
  return pairs;
}

async function decidePair(
  file: SideFile,
  target: Target,
  source: ChangedEntity,
  hit: Hit,
  resolver: Resolver,
  definitions: DefinitionCounter,
): Promise<Pair> {
  const side = target.sides[file.side]!;
  const classLike = ['class', 'interface', 'enum', 'type', 'namespace'].includes(
    target.entity.kind,
  );
  const relation: CodeRelation =
    classLike && hit.heritage ? 'implements' : !classLike && hit.call ? 'calls' : 'references';
  const notes: string[] = [];
  if (hit.chaining)
    notes.push(`${hit.chaining === 'this' ? 'this' : 'super'}(…) constructor chaining`);
  else if (hit.heritage) notes.push('base-class list');
  else notes.push(hit.call ? 'call' : 'reference');
  if (hit.receiver !== null && !hit.chaining) notes.push(`on ${hit.receiver}`);
  const alias = !hit.chaining && hit.name !== side.search;
  if (alias) notes.push(`through the alias ${hit.name}`);

  let imports: Decision | null = null;
  if (!hit.chaining) {
    const plain = hit.call && hit.receiver === null && !alias;
    if (plain && (await definitions.count(file.side, file.family, hit.name)) === 1) {
      notes.push('unambiguous: one definition, plain call');
    } else {
      imports = await resolver.decide(file.side, file.path, file.info, hit, side.key);
    }
  }
  return { target, source, file, hit, relation, notes, imports, lsp: null };
}

/** The innermost changed entity containing the hit, or null when it is in unchanged code. */
function enclosing(file: SideFile, hit: Hit): ChangedEntity | null {
  let best: Entity | null = null;
  for (const entity of file.entities) {
    if (!entity.members.some((r) => rangeContains(r, hit.line, hit.column))) continue;
    if (best === null || entity.depth > best.depth) best = entity;
  }
  if (best === null) return file.module;
  return file.changed.get(best) ?? null;
}

/** How many entities on a side define a name, across the whole snapshot. */
class DefinitionCounter {
  readonly #files: SnapshotFiles;
  readonly #parser: StructuralParser;
  readonly #changed: Map<string, Entity[]>;
  readonly #counts = new Map<string, Promise<number | null>>();

  constructor(files: SnapshotFiles, parser: StructuralParser, sideFiles: SideFile[]) {
    this.#files = files;
    this.#parser = parser;
    this.#changed = new Map(sideFiles.map((f) => [`${f.side}:${f.path}`, f.entities]));
  }

  count(side: Side, family: Family, name: string): Promise<number | null> {
    const key = `${side}:${family}:${name}`;
    let count = this.#counts.get(key);
    if (count === undefined) {
      count = this.#count(side, family, name);
      this.#counts.set(key, count);
    }
    return count;
  }

  async #count(side: Side, family: Family, name: string): Promise<number | null> {
    const found = await this.#files.grep(side, name);
    if (found === null) return null;
    const paths = found.filter((p) => {
      const grammar = detectLanguage(p);
      return grammar !== null && familyOf(grammar) === family;
    });
    if (paths.length > MAX_DEFINITION_FILES) return null;
    let count = 0;
    for (const path of paths) {
      let entities = this.#changed.get(`${side}:${path}`);
      if (entities === undefined) {
        const source = await this.#files.read(side, path);
        const parsed = source === null ? null : await this.#parser.parse(path, source);
        if (parsed?.status !== 'parsed') continue;
        try {
          entities = extractFacts(parsed).entities;
        } finally {
          freeTrees(parsed);
        }
      }
      count += entities.filter((e) => e.name === name).length;
    }
    return count;
  }
}

// ---------------------------------------------------------------------------------------------
// Steps 5-7 and caps: language servers, test files

/**
 * Asks a language server on `side` for each target's references (#16). A candidate inside a
 * returned site is confirmed. One that is missing is rejected only when the answer is complete,
 * the imports of both the target's and the candidate's file resolve, and nothing could reach
 * the target unseen: not through an overridden
 * base method, and not by constructor chaining, which `references` does not return.
 */
async function verify(pairs: Pair[], side: Side, lsp: ReferenceProvider): Promise<void> {
  const open = pairs.filter((p) => p.file.side === side && isOpen(p));
  // Per file, so one file whose imports do not resolve only stops rejections that involve it.
  const health = new Map<string, Promise<ProjectHealth>>();
  const healthy = async (language: string, path: string) => {
    const key = JSON.stringify([language, path]);
    let result = health.get(key);
    if (!result) {
      result = lsp.projectHealth(language, [path]);
      health.set(key, result);
    }
    return (await result).healthy;
  };

  for (const target of new Set(open.map((p) => p.target))) {
    const own = target.sides[side]!;
    const at = own.lsp!;
    const result = await lsp.references({
      language: at.language,
      path: own.path,
      line: at.line,
      column: at.column,
      kind: target.entity.kind,
    });
    if (result.status !== 'ok') continue;
    for (const pair of open.filter((p) => p.target === target)) {
      const isHit = (r: { path: string; range: SourceRange }) =>
        r.path === pair.file.path && rangeContains(r.range, pair.hit.line, pair.hit.column);
      const site = result.references.find(isHit);
      if (site) {
        pair.lsp = {
          outcome: 'confirmed',
          detail:
            site.via === 'base-method'
              ? 'textDocument/references, through an overridden base method'
              : 'textDocument/references',
        };
        continue;
      }
      if (pair.hit.chaining || own.mayOverride || !result.complete) continue;
      if (result.unresolved.some(isHit)) continue;
      const resolves =
        (await healthy(at.language, own.path)) && (await healthy(at.language, pair.file.path));
      if (!resolves) continue;
      pair.lsp = {
        outcome: 'rejected',
        detail: 'not among textDocument/references, and both files resolve',
      };
    }
  }
}

/** Not yet rejected, and a server can be asked about it on its side. */
function isOpen(pair: Pair): boolean {
  return (
    pair.imports?.verdict !== 'no' &&
    pair.lsp === null &&
    pair.target.sides[pair.file.side]!.lsp !== null
  );
}

function isRejected(pair: Pair): boolean {
  return pair.imports?.verdict === 'no' || pair.lsp?.outcome === 'rejected';
}

/** The graph edge a pair belongs to (src/graph/build.ts): a test file stands for its entities. */
function edgeKey(pair: Pair): string {
  const from = pair.file.test ? `file:${pair.file.filePath}` : pair.source.id;
  return JSON.stringify([pair.relation, from, pair.target.entity.id]);
}

/**
 * The old-side candidates a base-side server should decide (#66): those of edges with no
 * new-side hit left, either because the new side has none (a removed call) or because every
 * new-side hit was rejected. Elsewhere a new-side hit already carries the edge.
 */
function needOldSide(pairs: Pair[]): Pair[] {
  const carried = new Set(
    pairs.filter((p) => p.file.side === 'new' && !isRejected(p)).map(edgeKey),
  );
  return pairs.filter((p) => p.file.side === 'old' && isOpen(p) && !carried.has(edgeKey(p)));
}

/**
 * Carries a new-side `lsp` rejection over to the matching old-side hit that no server decided
 * (#66): the same source, target, relation, name and receiver, and the same position among the
 * hits that share those, when both sides have equally many. The base tree usually has no
 * installed dependencies, so a base-side server can rarely reject on its own, and otherwise the
 * old-side twin of a rejected call keeps the edge `possible`. It only ever drops an edge: if the
 * receiver's type changed between the sides, a real removed call is lost, and the detail names
 * the new-side hit so the reviewer can see why.
 */
function carryOverRejections(pairs: Pair[]): void {
  const groups = new Map<string, Record<Side, Pair[]>>();
  for (const pair of pairs) {
    if (pair.hit.chaining) continue;
    const key = JSON.stringify([
      pair.relation,
      pair.source.id,
      pair.target.entity.id,
      pair.hit.name,
      pair.hit.receiver,
    ]);
    const group = groups.get(key) ?? { old: [], new: [] };
    group[pair.file.side].push(pair);
    groups.set(key, group);
  }
  for (const { old, new: neu } of groups.values()) {
    if (old.length !== neu.length) continue;
    for (const [i, pair] of old.entries()) {
      const twin = neu[i]!;
      if (twin.lsp?.outcome !== 'rejected' || pair.lsp !== null || pair.imports !== null) continue;
      pair.lsp = {
        outcome: 'rejected',
        detail:
          `carried over from the new-side hit at ${twin.file.path}:${twin.hit.line}, which ` +
          `the new-side server rejected (${twin.lsp.detail})`,
      };
    }
  }
}

/**
 * One edge per (test file, changed entity) (D2): keeps the most decided hit of each on each
 * side, so the edge still shows whether the call was added, removed or kept, and notes how many
 * there were. The other hits stay visible in the diff.
 */
function collapseTestFiles(pairs: Pair[]): Pair[] {
  const groups = new Map<string, Pair[]>();
  for (const pair of pairs) {
    if (!pair.file.test) continue;
    const key = JSON.stringify([pair.file.filePath, pair.target.entity.id, pair.file.side]);
    groups.set(key, [...(groups.get(key) ?? []), pair]);
  }
  const keep = new Set<Pair>();
  for (const group of groups.values()) {
    const best = group.reduce((a, b) => (rank(b) < rank(a) ? b : a));
    if (group.length > 1) {
      best.notes.push(`test file: one hit for ${group.length} ${best.file.side}-side hits`);
    }
    keep.add(best);
  }
  return pairs.filter((p) => !p.file.test || keep.has(p));
}

function rank(pair: Pair): number {
  return pair.lsp?.outcome === 'confirmed'
    ? 0
    : pair.imports?.verdict === 'yes'
      ? 1
      : isRejected(pair)
        ? 3
        : 2;
}

/** Keeps the first `max` source entities per (target, relation) and reports the rest (D1). */
function applyCaps(pairs: Pair[], max: number): { kept: Pair[]; caps: FanOutCap[] } {
  const sources = new Map<string, string[]>();
  const keyOf = (p: Pair) => JSON.stringify([p.target.entity.id, p.relation]);
  const sourceOf = (p: Pair) => (p.file.test ? `file:${p.file.filePath}` : p.source.id);
  for (const pair of pairs) {
    const list = sources.get(keyOf(pair)) ?? [];
    if (!list.includes(sourceOf(pair))) list.push(sourceOf(pair));
    sources.set(keyOf(pair), list);
  }
  const caps: FanOutCap[] = [];
  for (const [key, list] of sources) {
    if (list.length <= max) continue;
    const [entityId, relation] = JSON.parse(key) as [string, CodeRelation];
    caps.push({ entityId, relation, shown: max, total: list.length });
  }
  const kept = pairs.filter((p) => sources.get(keyOf(p))!.indexOf(sourceOf(p)) < max);
  return { kept, caps };
}

// ---------------------------------------------------------------------------------------------
// Output

function records(pair: Pair): EvidenceRecord[] {
  const location = {
    path: pair.file.path,
    side: pair.file.side,
    range: {
      startLine: pair.hit.line,
      startColumn: pair.hit.column,
      endLine: pair.hit.line,
      endColumn: pair.hit.endColumn,
    },
  };
  const record = (
    method: EvidenceRecord['method'],
    outcome: EvidenceRecord['outcome'],
    detail: string,
  ): EvidenceRecord => ({
    id: stableId('ev', [
      method,
      pair.relation,
      pair.source.id,
      pair.target.entity.id,
      location.path,
      location.side,
      location.range.startLine,
      location.range.startColumn,
    ]),
    relation: pair.relation,
    sourceEntityId: pair.source.id,
    targetEntityId: pair.target.entity.id,
    location,
    method,
    outcome,
    detail,
  });
  const out = [record('text-search', 'candidate', pair.notes.join('; '))];
  if (pair.imports) {
    const outcome = pair.imports.verdict === 'yes' ? 'confirmed' : 'rejected';
    out.push(record('import-resolution', outcome, pair.imports.detail));
  }
  if (pair.lsp) out.push(record('lsp', pair.lsp.outcome, pair.lsp.detail));
  return out;
}

function withSide(capabilities: SessionCapability[], side: Side): LanguageCapability[] {
  return capabilities.map(({ language, ...rest }) => ({ language, side, ...rest }));
}

/** Capability without a language server: every relationship stays `possible` (D11). */
function withoutServers(files: AnalyzedFile[]): LanguageCapability[] {
  const languages = [...new Set(files.flatMap((f) => (f.language === null ? [] : [f.language])))];
  return languages.map((language) => ({
    language,
    side: 'new',
    server: null,
    status: 'disabled',
    capabilitiesAttempted: [],
    failures: [],
    guidance: `${language} callers: possible only — no language server was used for this run`,
  }));
}

// ---------------------------------------------------------------------------------------------
// Helpers

function sideOrder(side: Side): number {
  return side === 'new' ? 0 : 1;
}

function lastSegment(container: string | null): string | null {
  return container === null ? null : container.slice(container.lastIndexOf('.') + 1);
}

function sameRange(a: SourceRange, b: SourceRange): boolean {
  return (
    a.startLine === b.startLine &&
    a.startColumn === b.startColumn &&
    a.endLine === b.endLine &&
    a.endColumn === b.endColumn
  );
}

/** Whether `inner` lies inside `outer`. */
function within(inner: SourceRange, outer: SourceRange): boolean {
  return (
    startsIn(outer, inner) &&
    (inner.endLine < outer.endLine ||
      (inner.endLine === outer.endLine && (inner.endColumn ?? 1) <= (outer.endColumn ?? Infinity)))
  );
}

/** Whether `inner` starts inside `outer`, e.g. a constructor inside its class's declaration. */
function startsIn(outer: SourceRange, inner: SourceRange): boolean {
  return rangeContains(outer, inner.startLine, inner.startColumn ?? 1);
}
