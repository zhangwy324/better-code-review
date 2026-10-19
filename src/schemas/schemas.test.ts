import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  CONTRACTS,
  type ChangeGraph,
  type ChangeSet,
  type ContractName,
  parseContract,
  type ReviewFeedback,
  ReviewRequest,
  type ReviewPlan,
  SchemaVersionError,
  type SemanticEvidence,
  stableId,
  type StructuralChangeSet,
  UNGROUPED_GROUP_ID,
} from './index.ts';
import { jsonSchemas } from './json-schema.ts';

// A small, mutually consistent document set modelled on the signature fixture (spec M0):
// `formatPrice` gains `currency` and its changed caller `checkoutSummary` is updated.
const snapshotId = createHash('sha256').update('signature-fixture').digest('hex');
const hunkPrice = stableId('h', ['src/price.ts', 'src/price.ts', 1, 3, 1, 4]);
const hunkCheckout = stableId('h', ['src/checkout.ts', 'src/checkout.ts', 4, 1, 4, 1]);
const entPrice = stableId('ent', ['src/price.ts', null, 'function', 'formatPrice']);
const entCheckout = stableId('ent', ['src/checkout.ts', null, 'function', 'checkoutSummary']);
const nodePrice = stableId('n', ['symbol', entPrice]);
const nodeCheckout = stableId('n', ['symbol', entCheckout]);
const evidence = stableId('ev', ['text-search', 'calls', entCheckout, entPrice, 'src/checkout.ts', 'new', 5, 10]);
const edge = stableId('e', ['calls', nodeCheckout, nodePrice]);

const changeSet: ChangeSet = {
  schemaVersion: 1,
  snapshotId,
  target: { kind: 'range', base: 'main', head: 'feature', mode: 'merge-base' },
  baseRevision: '1'.repeat(40),
  headRevision: '2'.repeat(40),
  files: [
    {
      status: 'modified',
      oldPath: 'src/checkout.ts',
      newPath: 'src/checkout.ts',
      oldMode: '100644',
      newMode: '100644',
      binary: false,
      oldContent: "import { formatPrice } from './price';\n\nexport function checkoutSummary(t: number) {\n  return formatPrice(t);\n}\n",
      newContent: "import { formatPrice } from './price';\n\nexport function checkoutSummary(t: number) {\n  return formatPrice(t, 'EUR');\n}\n",
      contentOmitted: null,
      hunks: [
        {
          id: hunkCheckout,
          oldStart: 4,
          oldLines: 1,
          newStart: 4,
          newLines: 1,
          patch: "@@ -4 +4 @@ export function checkoutSummary(t: number) {\n-  return formatPrice(t);\n+  return formatPrice(t, 'EUR');\n",
        },
      ],
    },
    {
      status: 'added',
      oldPath: null,
      newPath: 'assets/logo.png',
      oldMode: null,
      newMode: '100644',
      binary: true,
      oldContent: null,
      newContent: null,
      contentOmitted: 'binary',
      hunks: [],
    },
  ],
};

const structural: StructuralChangeSet = {
  schemaVersion: 1,
  snapshotId,
  files: [
    { path: 'src/checkout.ts', language: 'typescript', tier: 'supported', test: null, skipped: null },
    { path: 'assets/logo.png', language: null, tier: 'text-only', test: null, skipped: 'binary' },
  ],
  entities: [
    {
      id: entCheckout,
      kind: 'function',
      name: 'checkoutSummary',
      container: null,
      path: 'src/checkout.ts',
      oldPath: null,
      change: 'modified',
      oldRange: { startLine: 3, endLine: 5 },
      newRange: { startLine: 3, endLine: 5 },
      hunkIds: [hunkCheckout],
    },
  ],
  unattributedHunkIds: [],
};

const semantic: SemanticEvidence = {
  schemaVersion: 1,
  snapshotId,
  languages: [
    {
      language: 'typescript',
      server: null,
      status: 'not-installed',
      capabilitiesAttempted: [],
      failures: [],
      guidance: 'Install typescript-language-server to verify TypeScript callers.',
    },
  ],
  records: [
    {
      id: evidence,
      relation: 'calls',
      sourceEntityId: entCheckout,
      targetEntityId: entPrice,
      location: {
        path: 'src/checkout.ts',
        side: 'new',
        range: { startLine: 4, startColumn: 10, endLine: 4, endColumn: 21 },
      },
      method: 'text-search',
      outcome: 'candidate',
      detail: null,
    },
  ],
  caps: [],
};

const graph: ChangeGraph = {
  schemaVersion: 1,
  snapshotId,
  files: structural.files,
  languages: semantic.languages,
  nodes: [
    {
      id: nodeCheckout,
      kind: 'symbol',
      entityId: entCheckout,
      entityKind: 'function',
      displayName: 'checkoutSummary',
      path: 'src/checkout.ts',
      oldPath: null,
      oldRange: { startLine: 3, endLine: 5 },
      newRange: { startLine: 3, endLine: 5 },
      hunkIds: [hunkCheckout],
    },
    {
      id: nodePrice,
      kind: 'symbol',
      entityId: entPrice,
      entityKind: 'function',
      displayName: 'formatPrice',
      path: 'src/price.ts',
      oldPath: null,
      oldRange: { startLine: 1, endLine: 3 },
      newRange: { startLine: 1, endLine: 4 },
      hunkIds: [hunkPrice],
    },
  ],
  codeEdges: [
    {
      id: edge,
      granularity: 'entity',
      from: nodeCheckout,
      to: nodePrice,
      relation: 'calls',
      provenance: 'possible',
      evidenceIds: [evidence],
    },
    {
      id: stableId('e', ['calls', 'src/price.test.ts', nodePrice]),
      granularity: 'test-file',
      fromPath: 'src/price.test.ts',
      to: nodePrice,
      relation: 'calls',
      provenance: 'possible',
      evidenceIds: [evidence],
    },
  ],
  evidence: semantic.records,
  caps: [{ entityId: entPrice, relation: 'calls', shown: 1, total: 1 }],
  uncoveredHunkIds: [],
};

const plan: ReviewPlan = {
  schemaVersion: 1,
  snapshotId,
  origin: 'agent',
  fallbackReason: null,
  summary: 'formatPrice takes a currency; callers pass it.',
  groups: [
    {
      id: 'contract',
      title: 'formatPrice signature',
      description: 'Adds the currency parameter.',
      nodeIds: [nodePrice],
      referenceNodeIds: [],
      childGroupIds: [],
    },
    {
      id: 'callers',
      title: 'Updated callers',
      description: '',
      nodeIds: [nodeCheckout],
      referenceNodeIds: [nodePrice],
      childGroupIds: [],
    },
  ],
  groupOrder: ['contract', 'callers'],
  edgeVerdicts: [
    {
      edgeId: edge,
      verdict: 'yes',
      via: 'direct',
      reason: 'formatPrice imported from ./price and called directly.',
      citedLine: { path: 'src/checkout.ts', side: 'new', line: 4 },
    },
  ],
  inferredRelationships: [
    {
      id: 'currency-propagation',
      from: nodePrice,
      to: nodeCheckout,
      kind: 'change-propagation',
      explanation: 'The new parameter is passed through.',
      citedLines: [{ path: 'src/checkout.ts', side: 'new', line: 4 }],
    },
  ],
};

const feedback: ReviewFeedback = {
  schemaVersion: 1,
  snapshotId,
  comments: [
    {
      id: crypto.randomUUID(),
      kind: 'line',
      path: 'src/checkout.ts',
      side: 'new',
      range: { startLine: 4, endLine: 4 },
      hunkId: hunkCheckout,
      nodeId: nodeCheckout,
      body: 'Should the currency come from the order?',
    },
    {
      id: 'c2',
      kind: 'line',
      path: 'src/checkout.ts',
      side: 'old',
      range: { startLine: 1, endLine: 1 },
      hunkId: null,
      nodeId: null,
      body: 'Context-line comment.',
    },
    { id: 'c3', kind: 'group', groupId: UNGROUPED_GROUP_ID, body: 'Why is the logo here?' },
  ],
  reviewedHunkIds: [hunkCheckout],
};

const examples: Record<ContractName, unknown> = {
  'change-set': changeSet,
  'structural-change-set': structural,
  'semantic-evidence': semantic,
  'change-graph': graph,
  'review-plan': plan,
  'review-feedback': feedback,
};
const names = Object.keys(CONTRACTS) as ContractName[];

describe('contracts', () => {
  it.each(names)('%s round-trips through JSON unchanged', (name) => {
    const json = JSON.stringify(examples[name]);
    const parsed = parseContract(name, JSON.parse(json));
    expect(parsed).toEqual(examples[name]);
    expect(JSON.stringify(parsed)).toBe(json);
  });

  it.each(names)('%s rejects unknown fields', (name) => {
    const doc = { ...(examples[name] as object), code: 'function injected() {}' };
    expect(() => parseContract(name, doc)).toThrow(ZodError);
  });

  it.each(names)('%s reports a version mismatch as such', (name) => {
    const doc = { ...(examples[name] as object), schemaVersion: 99 };
    expect(() => parseContract(name, doc)).toThrow(SchemaVersionError);
    expect(() => parseContract(name, doc)).toThrow(/written by a newer better-code-review/);
    expect(() => parseContract(name, null)).toThrow(SchemaVersionError);
  });

  it('rejects malformed IDs, paths and ranges', () => {
    const bad = (patch: (g: ChangeGraph) => void) => {
      const g = structuredClone(graph);
      patch(g);
      return () => parseContract('change-graph', g);
    };
    expect(bad((g) => (g.nodes[0]!.id = 'n_XYZ'))).toThrow(ZodError);
    expect(bad((g) => (g.nodes[0]!.id = hunkCheckout))).toThrow(ZodError);
    expect(bad((g) => (g.nodes[0]!.path = '/etc/passwd'))).toThrow(ZodError);
    expect(bad((g) => (g.nodes[0]!.path = 'src/../../x'))).toThrow(ZodError);
    expect(bad((g) => (g.nodes[0]!.newRange = { startLine: 5, endLine: 3 }))).toThrow(ZodError);
    expect(bad((g) => (g.codeEdges[0]!.evidenceIds = []))).toThrow(ZodError);
  });

  it('rejects plan IDs that are not safe local IDs', () => {
    const p = structuredClone(plan);
    p.groups[0]!.id = '<script>';
    expect(() => parseContract('review-plan', p)).toThrow(ZodError);
  });

  it('parses each review target kind', () => {
    const request = (target: unknown) => ({
      repositoryPath: '/repo',
      target,
      outputDirectory: '/repo/.better-code-review/reviews/pr-1',
      analysis: { useLsp: true, allowProjectCodeExecution: false },
    });
    for (const target of [
      { kind: 'pr', number: 1 },
      { kind: 'commit', commit: 'HEAD' },
      { kind: 'commit', commit: 'abc1234', parent: 2 },
      { kind: 'local', includeUntracked: true },
      { kind: 'range', base: 'main', head: 'HEAD', mode: 'direct' },
    ]) {
      expect(ReviewRequest.parse(request(target)).target).toEqual(target);
    }
    expect(() => ReviewRequest.parse(request({ kind: 'pr', number: 0 }))).toThrow(ZodError);
  });
});

describe('stableId', () => {
  it('is deterministic and prefix-typed', () => {
    expect(stableId('h', ['a', 1])).toBe(stableId('h', ['a', 1]));
    expect(stableId('h', ['a', 1])).toMatch(/^h_[0-9a-f]{16}$/);
    expect(stableId('n', ['a', 1]).slice(2)).toBe(stableId('h', ['a', 1]).slice(2));
  });

  it('keeps part boundaries', () => {
    expect(stableId('h', ['a', 'b'])).not.toBe(stableId('h', ['a,b']));
    expect(stableId('h', ['1'])).not.toBe(stableId('h', [1]));
  });
});

describe('JSON Schema export', () => {
  const schemasDir = new URL('../../schemas/', import.meta.url);

  it('is up to date (run `npm run schemas` if this fails)', () => {
    const expected = jsonSchemas();
    expect(readdirSync(schemasDir).sort()).toEqual(Object.keys(expected).sort());
    for (const [file, schema] of Object.entries(expected)) {
      expect(readFileSync(new URL(file, schemasDir), 'utf8')).toBe(
        `${JSON.stringify(schema, null, 2)}\n`,
      );
    }
  });

  it.each(names)('%s accepts the example and rejects unknown fields', (name) => {
    const validate = new Ajv2020({ strict: true }).compile(
      jsonSchemas()[`${name}.schema.json`],
    );
    expect(validate(examples[name]), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...(examples[name] as object), code: 'x' })).toBe(false);
  });
});
