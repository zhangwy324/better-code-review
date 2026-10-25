// The structural analyzer (#15, design reference §8.3, §9.3): which code entities each hunk
// touches. Reads a ChangeSet and produces its StructuralChangeSet.
//
// Attribution: each added line is looked up on the new side and each removed line on the old
// side; context lines are not changes and are ignored. A line belongs to the innermost entities
// containing it (a method, not its class; both of two one-liners sharing a line), and a hunk is
// attached to every entity one of its lines belongs to (MVP spec D2). Lines outside any entity
// go to the file's `module` entity. Files without structure (no grammar, binary, too large,
// generated, not UTF-8) have no entities: their hunks are listed in `unattributedHunkIds`, and
// the graph gives them a file node.
//
// Syntax errors (#93): tree-sitter's recovery can put code in the wrong entity, so an entity
// overlapping an ERROR or MISSING node is dropped, on both sides. The rest of the file keeps its
// entities and is marked `partialParse`. A changed line in an error or a dropped entity belongs
// to nothing: if no other line of its hunk has an owner, the hunk is unattributed.
import {
  GITLINK_MODE,
  SYMLINK_MODE,
  type ChangeSet,
  type FileChange,
} from '../../schemas/changeset.ts';
import type { SourceRange } from '../../schemas/common.ts';
import { stableId } from '../../schemas/ids.ts';
import {
  STRUCTURAL_SCHEMA_VERSION,
  StructuralChangeSet,
  type AnalyzedFile,
  type ChangedEntity,
} from '../../schemas/structural.ts';
import { hunkLines } from '../../git/patch.ts';
import { extractFacts, type Entity, type FileFacts } from './entities.ts';
import { detectLanguage, type GrammarName } from './languages.ts';
import { matchEntities, type EntityPair, type FileEntities } from './match.ts';
import { StructuralParser, freeTrees, type ParseResult } from './parser.ts';
import { NO_TEST_ROOTS, classifyTestFile, type TestRoots } from './test-files.ts';

/**
 * Files larger than this on either side are not parsed. WASM memory grows with the largest
 * file and never shrinks: a 9 MB file took ~600 MB in ADR 0001.
 */
export const MAX_PARSE_BYTES = 1024 * 1024;

export interface StructuralOptions {
  /** From `declaredTestRoots()`. Defaults to none: path conventions only. */
  testRoots?: TestRoots;
  maxParseBytes?: number;
}

interface AnalysedFile {
  index: number;
  change: FileChange;
  old: FileFacts | null;
  new: FileFacts | null;
  unparsed: Unparsed;
}

interface LineRange {
  startLine: number;
  endLine: number;
}

/** Each side's lines with no trusted entity: syntax errors and the entities dropped around them. */
interface Unparsed {
  old: LineRange[];
  new: LineRange[];
}

export async function analyzeStructure(
  changeSet: ChangeSet,
  options: StructuralOptions = {},
): Promise<StructuralChangeSet> {
  const testRoots = options.testRoots ?? NO_TEST_ROOTS;
  const maxParseBytes = options.maxParseBytes ?? MAX_PARSE_BYTES;
  const files: AnalyzedFile[] = [];
  const analysed: AnalysedFile[] = [];
  const unattributedHunkIds: string[] = [];

  const parser = new StructuralParser();
  try {
    for (const [index, change] of changeSet.files.entries()) {
      const path = filePath(change);
      const result = await analyseFile(parser, change, maxParseBytes);
      const facts = result.facts?.new ?? result.facts?.old ?? null;
      const content = facts && {
        imports: facts.imports,
        testDeclarations: facts.entities.some((e) => e.test),
      };
      files.push({
        path,
        language: result.language,
        tier: result.language === null ? 'text-only' : 'supported',
        test: classifyTestFile(path, testRoots, content),
        skipped: result.skipped,
        partialParse: result.partialParse,
      });
      if (result.facts === null) unattributedHunkIds.push(...change.hunks.map((h) => h.id));
      else analysed.push({ index, change, ...result.facts, unparsed: result.unparsed });
    }
  } finally {
    parser.delete();
  }

  // Which hunks each entity's lines are in, and which hunks have lines outside every entity.
  const hunksOf = new Map<Entity, Set<string>>();
  const moduleHunks = new Map<number, string[]>();
  for (const file of analysed) {
    for (const hunk of file.change.hunks) {
      let outside = false;
      let owned = false;
      for (const line of hunkLines(hunk)) {
        if (line.kind === 'context') continue;
        const side = line.kind === 'removed' ? 'old' : 'new';
        const number = (line.kind === 'removed' ? line.oldLine : line.newLine)!;
        const owners = innermost(file[side]?.entities ?? [], number);
        for (const e of owners) hunksOf.set(e, (hunksOf.get(e) ?? new Set()).add(hunk.id));
        if (owners.length > 0) owned = true;
        else if (!file.unparsed[side].some((r) => r.startLine <= number && number <= r.endLine)) {
          outside = true;
        }
      }
      if (outside) moduleHunks.set(file.index, [...(moduleHunks.get(file.index) ?? []), hunk.id]);
      else if (!owned) unattributedHunkIds.push(hunk.id);
    }
  }

  const hunkOrder = new Map(changeSet.files.flatMap((f) => f.hunks).map((h, i) => [h.id, i]));
  const ordered = (ids: Iterable<string>) =>
    [...new Set(ids)].sort((a, b) => hunkOrder.get(a)! - hunkOrder.get(b)!);

  // Sorted by file, then module first, then position.
  const entries: { entity: ChangedEntity; order: [number, number] }[] = [];
  for (const [index, hunkIds] of moduleHunks) {
    const change = changeSet.files[index]!;
    const otherPath =
      change.oldPath !== null && change.newPath !== null && change.oldPath !== change.newPath;
    const entity: ChangedEntity = {
      id: stableId('ent', [filePath(change), null, 'module', null]),
      kind: 'module',
      name: null,
      container: null,
      path: filePath(change),
      oldPath: otherPath ? change.oldPath : null,
      change:
        change.status === 'added'
          ? 'added'
          : change.status === 'deleted'
            ? 'deleted'
            : change.status === 'renamed'
              ? 'moved'
              : 'modified',
      oldRange: null,
      newRange: null,
      hunkIds: ordered(hunkIds),
    };
    entries.push({ entity, order: [index, 0] });
  }

  const fileEntities: FileEntities[] = analysed.map((f) => ({
    file: f.index,
    old: f.old?.entities ?? [],
    new: f.new?.entities ?? [],
  }));
  const ids = new Set<string>();
  for (const pair of matchEntities(fileEntities)) {
    const hunkIds = [
      ...(pair.old ? (hunksOf.get(pair.old.entity) ?? []) : []),
      ...(pair.new ? (hunksOf.get(pair.new.entity) ?? []) : []),
    ];
    if (hunkIds.length === 0) continue;
    const entity = toChangedEntity(changeSet, pair, ordered(hunkIds));
    // Same path, container, kind and name on both sides would have matched, so a clash means
    // an added and a deleted entity whose parents did not match. Keep their IDs apart.
    if (ids.has(entity.id)) {
      entity.id = stableId('ent', [
        entity.path,
        entity.container,
        entity.kind,
        entity.name,
        entity.change,
      ]);
    }
    ids.add(entity.id);
    const side = pair.new ?? pair.old!;
    entries.push({ entity, order: [side.file, side.entity.range.startLine] });
  }
  entries.sort(
    (a, b) =>
      a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.entity.id.localeCompare(b.entity.id),
  );

  return StructuralChangeSet.parse({
    schemaVersion: STRUCTURAL_SCHEMA_VERSION,
    snapshotId: changeSet.snapshotId,
    files,
    entities: entries.map((e) => e.entity),
    unattributedHunkIds: ordered(unattributedHunkIds),
  });
}

function filePath(change: FileChange): string {
  // The schema guarantees at least one side has a path.
  return (change.newPath ?? change.oldPath)!;
}

interface FileResult {
  language: GrammarName | null;
  skipped: AnalyzedFile['skipped'];
  partialParse: boolean;
  /** Null when the file has no structure; see the header. */
  facts: { old: FileFacts | null; new: FileFacts | null } | null;
  unparsed: Unparsed;
}

async function analyseFile(
  parser: StructuralParser,
  change: FileChange,
  maxParseBytes: number,
): Promise<FileResult> {
  const sides = [
    { path: change.oldPath, mode: change.oldMode, content: change.oldContent },
    { path: change.newPath, mode: change.newMode, content: change.newContent },
  ].filter((s) => s.path !== null);
  // Symlinks hold a target path and gitlinks a commit, never code, whatever their name says.
  const languages = sides.map((s) =>
    s.mode === SYMLINK_MODE || s.mode === GITLINK_MODE ? null : detectLanguage(s.path!),
  );
  const language = languages.includes(null) ? null : (languages.at(-1) ?? null);
  const none = (skipped: AnalyzedFile['skipped']): FileResult => ({
    language,
    skipped,
    partialParse: false,
    facts: null,
    unparsed: { old: [], new: [] },
  });

  if (change.binary) return none('binary');
  if (language === null) return none(null);
  if (change.contentOmitted === 'too-large') return none('too-large');
  // No text to parse: the extractor would only have had a garbled decoding.
  if (change.contentOmitted === 'not-utf8') return none('parse-error');
  const contents = sides.map((s) => s.content ?? '');
  if (contents.some((c) => Buffer.byteLength(c, 'utf8') > maxParseBytes)) return none('too-large');
  if (sides.some((s, i) => isGenerated(s.path!, contents[i]!))) return none('generated');

  let parsed: { old: ParseResult | null; new: ParseResult | null } = { old: null, new: null };
  try {
    parsed = await parser.parseVersions(change);
    const facts = {
      old: parsed.old?.status === 'parsed' ? extractFacts(parsed.old) : null,
      new: parsed.new?.status === 'parsed' ? extractFacts(parsed.new) : null,
    };
    const unparsed = dropErrorEntities(facts);
    const partialParse = [facts.old, facts.new].some((f) => f !== null && f.errorLines.length > 0);
    return { language, skipped: null, partialParse, facts, unparsed };
  } finally {
    freeTrees(parsed);
  }
}

/**
 * Generated or minified code: a conventional name, a generator's header comment, or minified
 * lines. Its entities are not worth reviewing one by one; it gets a file node instead.
 */
function isGenerated(path: string, content: string): boolean {
  if (/(?:\.min\.[cm]?js|\.generated\.\w+|_pb2(?:_grpc)?\.pyi?)$/.test(path)) return true;
  // Only comments count: a generator that writes such a header is not generated itself.
  const header = content
    .split('\n', 5)
    .filter((line) => /^\s*(?:\/\/|#|\/\*|\*|"""|''')/.test(line))
    .join('\n');
  if (/@generated\b|\bDO NOT EDIT\b|\bauto-?generated\b/i.test(header)) return true;
  return content.split('\n').some((line) => line.length > 2000);
}

/**
 * Drops the entities that overlap a syntax error, where tree-sitter's recovery can put code in
 * the wrong entity (#93), and the entities of the same container, kind and name on the other
 * side, so an error does not read as an added or deleted entity. A kept entity whose parent was
 * dropped hangs from its nearest kept ancestor, so it still matches by name; its container is
 * unchanged. Returns each side's lines left without an entity.
 */
function dropErrorEntities(facts: { old: FileFacts | null; new: FileFacts | null }): Unparsed {
  const key = (e: Entity) => JSON.stringify([e.container, e.kind, e.name]);
  const overlaps = (r: LineRange, s: LineRange) =>
    r.startLine <= s.endLine && s.startLine <= r.endLine;
  const dropped = new Set(
    [facts.old, facts.new].flatMap((f) =>
      f === null
        ? []
        : f.entities.filter((e) => f.errorLines.some((r) => overlaps(r, e.range))).map(key),
    ),
  );
  const prune = (f: FileFacts | null): LineRange[] => {
    if (f === null) return [];
    const kept = f.entities.filter((e) => !dropped.has(key(e)));
    const unparsed: LineRange[] = [...f.errorLines];
    for (const e of f.entities) if (dropped.has(key(e))) unparsed.push(...e.members);
    // Parents come before their children, so each parent is settled before it is used.
    for (const e of kept) {
      while (e.parent !== null && dropped.has(key(e.parent))) e.parent = e.parent.parent;
      e.depth = e.parent === null ? 0 : e.parent.depth + 1;
    }
    f.entities = kept;
    return unparsed;
  };
  return { old: prune(facts.old), new: prune(facts.new) };
}

/**
 * The entities whose member contains `line`, keeping only the innermost: a member that contains
 * another candidate is dropped.
 */
function innermost(entities: Entity[], line: number): Entity[] {
  const candidates = entities.flatMap((entity) =>
    entity.members
      .filter((r) => r.startLine <= line && line <= r.endLine)
      .map((range) => ({ entity, range })),
  );
  const inner = candidates.filter(
    (c) => !candidates.some((d) => d !== c && d.entity !== c.entity && contains(c.range, d.range)),
  );
  return [...new Set(inner.map((c) => c.entity))];
}

/** Whether `outer` contains `inner`, comparing (line, column) positions. */
function contains(outer: SourceRange, inner: SourceRange): boolean {
  const before = (l1: number, c1 = 1, l2: number, c2 = 1) => l1 < l2 || (l1 === l2 && c1 <= c2);
  return (
    before(outer.startLine, outer.startColumn, inner.startLine, inner.startColumn) &&
    before(inner.endLine, inner.endColumn, outer.endLine, outer.endColumn)
  );
}

function toChangedEntity(changeSet: ChangeSet, pair: EntityPair, hunkIds: string[]): ChangedEntity {
  const oldChange = pair.old && changeSet.files[pair.old.file]!;
  const newChange = pair.new && changeSet.files[pair.new.file]!;
  const entity = (pair.new ?? pair.old)!.entity;
  const path = newChange ? newChange.newPath! : oldChange!.oldPath!;
  const oldPath = oldChange?.oldPath ?? null;
  let change: ChangedEntity['change'];
  if (pair.old === null) change = 'added';
  else if (pair.new === null) change = 'deleted';
  // A copy's old side is its source, which stays where it was: nothing moved.
  else if ((oldPath !== path && newChange?.status !== 'copied') || pair.reparented) {
    change = 'moved';
  } else if (pair.old.entity.name !== pair.new.entity.name) change = 'renamed';
  else change = 'modified';
  return {
    id: stableId('ent', [path, entity.container, entity.kind, entity.name]),
    kind: entity.kind,
    name: entity.name,
    container: entity.container,
    path,
    oldPath: oldPath !== null && oldPath !== path ? oldPath : null,
    change,
    oldRange: pair.old?.entity.range ?? null,
    newRange: pair.new?.entity.range ?? null,
    hunkIds,
  };
}
