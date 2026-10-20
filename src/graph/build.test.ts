import { describe, expect, it } from 'vitest';
import type { ReferenceProvider } from '../analysis/semantic/analyze.ts';
import {
  analyse,
  SIGNATURE_BASE,
  SIGNATURE_HEAD,
  type Analysed,
  type Files,
} from '../analysis/semantic/fixture.test-helper.ts';
import type { ReferencesResult } from '../analysis/semantic/session.ts';
import { analyzeStructure } from '../analysis/structural/analyze.ts';
import { extractChangeSet } from '../git/extract.ts';
import { TestRepo } from '../git/test-repo.test-helper.ts';
import type { ChangeGraph } from '../schemas/graph.ts';
import { stableId } from '../schemas/ids.ts';
import { buildGraph } from './build.ts';

// Fixtures are real two-commit repositories run through the Git extractor and both analyzers
// (test/fixtures/signature.ts).
const lines = (...l: string[]) => `${l.join('\n')}\n`;

const full = ({ changes, structure, evidence }: Analysed) =>
  buildGraph(changes, { structure, evidence });

/** One line per node: `kind displayName (hunk count)`. */
function nodeSummary(graph: ChangeGraph): string[] {
  return graph.nodes.map((n) => `${n.kind} ${n.displayName} (${n.hunkIds.length})`);
}

/** One line per edge: `provenance relation from -> to (records)`, by display name or path. */
function edgeSummary(graph: ChangeGraph): string[] {
  const name = (id: string) => graph.nodes.find((n) => n.id === id)!.displayName;
  return graph.codeEdges.map((e) => {
    const from = e.granularity === 'entity' ? name(e.from) : `file ${e.fromPath}`;
    return `${e.provenance} ${e.relation} ${from} -> ${name(e.to)} (${e.evidenceIds.length})`;
  });
}

const tiers = (g: ChangeGraph) => [g.weakestTier, g.strongestTier];
const fileTiers = (g: ChangeGraph) =>
  Object.fromEntries(g.files.map((f) => [f.path, f.capabilityTier]));

function allHunkIds(a: Analysed): string[] {
  return a.changes.files.flatMap((f) => f.hunks.map((h) => h.id));
}

describe('buildGraph on the signature fixture (M1 acceptance)', () => {
  it('without LSP: possible edges from the changed callers, nothing verified', async () => {
    const result = await analyse(SIGNATURE_BASE, SIGNATURE_HEAD);
    const graph = full(result);
    expect(tiers(graph)).toEqual(['git-only', 'structural']);
    expect(fileTiers(graph)).toMatchObject({
      'config.json': 'git-only',
      'src/price.ts': 'structural',
    });
    expect(nodeSummary(graph)).toEqual([
      'symbol use_calc (1)',
      'file config.json (1)',
      'symbol order_total (1)',
      'symbol refund (1)',
      'symbol checkoutSummary (1)',
      'symbol viaMethod (1)',
      'symbol invoiceSummary (1)',
      'symbol legacyLabel (1)',
      'symbol formatPrice (1)',
      'symbol receiptSummary (1)',
      'symbol aliasCaller (1)',
      'symbol tax (1)',
    ]);
    // Each edge stands for the new-side and the old-side hit. legacyLabel calls the other
    // formatPrice: import resolution rejected it, so it has no edge. emailSummary is unchanged.
    expect(edgeSummary(graph)).toEqual([
      'possible calls checkoutSummary -> formatPrice (4)',
      'possible calls viaMethod -> formatPrice (2)',
      'possible calls invoiceSummary -> formatPrice (4)',
      'possible calls receiptSummary -> formatPrice (4)',
      'possible calls aliasCaller -> formatPrice (4)',
      'possible calls use_calc -> tax (2)',
      'possible calls order_total -> tax (4)',
      'possible calls refund -> tax (4)',
    ]);
    expect(JSON.stringify(graph)).not.toContain('emailSummary');
    // The graph carries exactly the records its edges cite.
    expect(graph.evidence.map((r) => r.id).sort()).toEqual(
      graph.codeEdges.flatMap((e) => e.evidenceIds).sort(),
    );
    expect(graph.evidence.some((r) => r.outcome === 'rejected')).toBe(false);
    expect(graph.languages).toEqual(result.evidence.languages);
    expect(graph.uncoveredHunkIds).toEqual([]);
    expect(new Set(graph.nodes.flatMap((n) => n.hunkIds))).toEqual(new Set(allHunkIds(result)));
  });

  it('keeps node to hunk and source-range mappings from the structural analyzer', async () => {
    const result = await analyse(SIGNATURE_BASE, SIGNATURE_HEAD);
    const graph = full(result);
    const price = result.structure.entities.find((e) => e.name === 'formatPrice')!;
    expect(graph.nodes.find((n) => n.entityId === price.id)).toEqual({
      id: expect.stringMatching(/^n_/) as string,
      kind: 'symbol',
      entityId: price.id,
      entityKind: 'function',
      displayName: 'formatPrice',
      path: 'src/price.ts',
      oldPath: null,
      oldRange: price.oldRange,
      newRange: price.newRange,
      hunkIds: price.hunkIds,
    });
  });

  it('is identical on two runs of the same snapshot', async () => {
    const [a, b] = await Promise.all([
      analyse(SIGNATURE_BASE, SIGNATURE_HEAD),
      analyse(SIGNATURE_BASE, SIGNATURE_HEAD),
    ]);
    expect(JSON.stringify(full(a))).toBe(JSON.stringify(full(b)));
    const graph = full(a);
    const ids = [...graph.nodes.map((n) => n.id), ...graph.codeEdges.map((e) => e.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('with a language server: verified edges cite confirmed LSP records', async () => {
    const references = (): ReferencesResult => ({
      status: 'ok',
      references: [
        {
          path: 'src/checkout.ts',
          range: { startLine: 4, startColumn: 25, endLine: 4, endColumn: 36 },
          via: 'direct',
        },
      ],
      unresolved: [],
      excluded: [],
      complete: true,
    });
    const lsp: ReferenceProvider = {
      references: () => Promise.resolve(references()),
      projectHealth: () =>
        Promise.resolve({ healthy: true, imports: 1, unresolved: [], reason: null }),
      capabilities: () => [
        {
          language: 'typescript',
          server: { name: 'fake', version: null, configuration: null },
          status: 'ok',
          capabilitiesAttempted: ['references'],
          failures: [],
          guidance: null,
        },
      ],
    };
    const result = await analyse(SIGNATURE_BASE, SIGNATURE_HEAD, { lsp });
    const graph = full(result);
    expect(tiers(graph)).toEqual(['git-only', 'semantic']);
    // The fake server answered for TypeScript only.
    expect(fileTiers(graph)).toMatchObject({ 'src/price.ts': 'semantic', 'tax.py': 'structural' });
    const ts = edgeSummary(graph).filter((e) => e.includes('-> formatPrice'));
    // The server returned checkoutSummary only, so it rejected the other new-side candidates.
    // viaMethod's old-side twin gets that rejection carried over (#66). The other old-side hits
    // were confirmed by import resolution, which a carried-over rejection does not overrule, so
    // only those hits keep their edges possible.
    expect(ts).toEqual([
      'verified calls checkoutSummary -> formatPrice (5)',
      'possible calls invoiceSummary -> formatPrice (2)',
      'possible calls receiptSummary -> formatPrice (2)',
      'possible calls aliasCaller -> formatPrice (2)',
    ]);
    const verified = graph.codeEdges.find((e) => e.provenance === 'verified')!;
    const cited = graph.evidence.filter((r) => verified.evidenceIds.includes(r.id));
    expect(cited).toContainEqual(expect.objectContaining({ method: 'lsp', outcome: 'confirmed' }));
    expect(verified.sides).toBe('both');
    expect(graph.codeEdges.find((e) => e.id !== verified.id)?.sides).toBe('old');
  });

  it('a removed call confirmed on the old side is a verified edge on the old side (#66)', async () => {
    const caller = (call: string) =>
      lines(
        "import { formatPrice } from './price';",
        'export function total() {',
        `  return ${call};`,
        '}',
      );
    const result = await analyse(
      {
        'src/price.ts': lines(
          'export function formatPrice(n: number) {',
          '  return String(n);',
          '}',
        ),
        'src/total.ts': caller('formatPrice(1)'),
      },
      {
        'src/price.ts': lines('export function formatPrice(n: number) {', "  return n + '';", '}'),
        'src/total.ts': caller('1'),
      },
      {
        lsp: fakeLsp(() => ({
          status: 'ok',
          references: [],
          unresolved: [],
          excluded: [],
          complete: true,
        })),
        oldLsp: () =>
          Promise.resolve(
            fakeLsp(() => ({
              status: 'ok',
              references: [
                {
                  path: 'src/total.ts',
                  range: { startLine: 3, startColumn: 10, endLine: 3, endColumn: 21 },
                  via: 'direct',
                },
              ],
              unresolved: [],
              excluded: [],
              complete: true,
            })),
          ),
      },
    );
    const graph = full(result);
    expect(edgeSummary(graph)).toEqual(['verified calls total -> formatPrice (2)']);
    expect(graph.codeEdges[0]!.sides).toBe('old');
  });
});

function fakeLsp(references: () => ReferencesResult): ReferenceProvider {
  return {
    references: () => Promise.resolve(references()),
    projectHealth: () =>
      Promise.resolve({ healthy: true, imports: 1, unresolved: [], reason: null }),
    capabilities: () => [],
  };
}

describe('buildGraph: capability tiers', () => {
  it('git-only: one file node per file and no edges', async () => {
    const result = await analyse(SIGNATURE_BASE, SIGNATURE_HEAD);
    const graph = buildGraph(result.changes);
    expect(tiers(graph)).toEqual(['git-only', 'git-only']);
    expect(graph.nodes.map((n) => n.kind)).toEqual(result.changes.files.map(() => 'file'));
    expect(graph.nodes.map((n) => n.displayName)).toEqual(
      result.changes.files.map((f) => f.newPath ?? f.oldPath),
    );
    expect(graph.files.every((f) => f.tier === 'text-only' && f.language === null)).toBe(true);
    expect(graph.codeEdges).toEqual([]);
    expect(graph.languages).toEqual([]);
    expect(graph.uncoveredHunkIds).toEqual([]);
  });

  it('structural: entity nodes, no edges', async () => {
    const result = await analyse(SIGNATURE_BASE, SIGNATURE_HEAD);
    const graph = buildGraph(result.changes, { structure: result.structure });
    expect(tiers(graph)).toEqual(['git-only', 'structural']);
    expect(nodeSummary(graph)).toEqual(nodeSummary(full(result)));
    expect(graph.codeEdges).toEqual([]);
    expect(graph.evidence).toEqual([]);
  });

  it('an empty change claims nothing: git-only at both ends', async () => {
    const repo = new TestRepo();
    const base = repo.commit([], { 'a.txt': 'a\n' });
    const changes = await extractChangeSet(repo.path, {
      kind: 'commit',
      commit: repo.commit([base], {}),
    });
    const graph = buildGraph(changes, { structure: await analyzeStructure(changes) });
    expect(graph.files).toEqual([]);
    expect(tiers(graph)).toEqual(['git-only', 'git-only']);
  });

  it('refuses evidence without its structure, or analysis of another snapshot', async () => {
    const a = await analyse(SIGNATURE_BASE, SIGNATURE_HEAD);
    const b = await analyse({ 'a.txt': 'a\n' }, { 'a.txt': 'b\n' });
    expect(() => buildGraph(a.changes, { evidence: a.evidence })).toThrow(/structural/);
    expect(() => buildGraph(a.changes, { structure: b.structure })).toThrow(/snapshot/);
  });
});

describe('buildGraph: edges', () => {
  it('a removed call verified on the old side makes a verified edge', async () => {
    const price = (params: string) =>
      lines(`export function formatPrice(${params}) {`, '  return String(amount);', '}');
    const total = (body: string) =>
      lines(
        "import { formatPrice } from './price';",
        'export function total(n: number) {',
        `  return ${body};`,
        '}',
      );
    const result = await analyse(
      { 'src/price.ts': price('amount: number'), 'src/total.ts': total('formatPrice(n)') },
      { 'src/price.ts': price('amount: number, c: string'), 'src/total.ts': total('String(n)') },
    );
    expect(edgeSummary(full(result))).toEqual(['possible calls total -> formatPrice (1)']);

    // The analyzer does not ask a server about the old side yet; add what it would record.
    const [hit] = result.evidence.records;
    const lsp = { ...hit!, method: 'lsp' as const, outcome: 'confirmed' as const, detail: null };
    lsp.id = stableId('ev', [
      'lsp',
      hit!.relation,
      hit!.sourceEntityId,
      hit!.targetEntityId,
      'src/total.ts',
      'old',
      3,
      10,
    ]);
    const evidence = { ...result.evidence, records: [hit!, lsp] };
    const graph = buildGraph(result.changes, { structure: result.structure, evidence });
    expect(edgeSummary(graph)).toEqual(['verified calls total -> formatPrice (2)']);
    expect(hit!.location).toMatchObject({ side: 'old', range: { startLine: 3, startColumn: 10 } });
  });
});

describe('buildGraph: nodes', () => {
  it('module nodes for top-level code, file nodes for files without structure', async () => {
    const repo = new TestRepo();
    const base = repo.commit([], {
      'src/a.ts': lines("import { x } from './x';", 'export function f() {', '  return 1;', '}'),
      'logo.png': Buffer.from([0x89, 0x50, 0, 1]),
      'run.sh': 'echo hi\n',
    });
    const head = repo.commit([base], {
      'src/a.ts': lines("import { y } from './y';", 'export function f() {', '  return 2;', '}'),
      'logo.png': Buffer.from([0x89, 0x50, 0, 2]),
      'run.sh': { mode: '100755', content: 'echo hi\n' },
    });
    const changes = await extractChangeSet(repo.path, { kind: 'commit', commit: head });
    const graph = buildGraph(changes, { structure: await analyzeStructure(changes) });
    expect(
      graph.nodes.map((n) => [n.kind, n.displayName, n.path, n.oldPath, n.hunkIds.length]),
    ).toEqual([
      ['file', 'logo.png', 'logo.png', null, 0],
      // A mode-only change has no hunks, but is still a change to review.
      ['file', 'run.sh', 'run.sh', null, 0],
      ['module', 'src/a.ts', 'src/a.ts', null, 1],
      ['symbol', 'f', 'src/a.ts', null, 1],
    ]);
    expect(graph.nodes.find((n) => n.kind === 'module')).toMatchObject({
      entityKind: null,
      oldRange: null,
      newRange: null,
    });
  });

  it('relates a test file to the entity it exercises at file level (D2)', async () => {
    const test = (n: number): Files[string] =>
      lines(
        "import { formatPrice } from '../src/price';",
        "it('formats', () => {",
        `  expect(formatPrice(${n})).toBe('1');`,
        '});',
      );
    const price = (body: string) =>
      lines('export function formatPrice(amount: number) {', `  return ${body};`, '}');
    const result = await analyse(
      { 'src/price.ts': price('String(amount)'), 'test/price.test.ts': test(1) },
      { 'src/price.ts': price("amount + ''"), 'test/price.test.ts': test(2) },
    );
    const graph = full(result);
    // The analyzer keeps one hit per (test file, entity) and side, so the edge cites two records.
    expect(edgeSummary(graph)).toEqual([
      'possible calls file test/price.test.ts -> formatPrice (2)',
    ]);
    expect(graph.codeEdges[0]!.sides).toBe('both');
    // The test still has its own node, so its hunk is covered.
    expect(nodeSummary(graph)).toContain('symbol formats (1)');
  });
});
