// Scoring caller verdicts (#43) with stubbed runs: no model is called.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { selectCandidates } from '../../src/planner/index.ts';
import { ChangeGraph, type EdgeVerdict } from '../../src/schemas/index.ts';
import { signature } from '../fixtures/signature.ts';
import {
  consistency,
  fixtureTruth,
  formatReports,
  lspTruth,
  reportRuns,
  scoreVerdicts,
  type ScoredRun,
} from './adjudication.ts';
import { modelInput } from './input.ts';

const root = mkdtempSync(join(tmpdir(), 'bcr-adjudication-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let built: ReturnType<typeof build> | undefined;
const signatureReview = () => (built ??= build());

async function build() {
  const input = await modelInput('skill', signature, join(root, 'signature'));
  const graph = ChangeGraph.parse(
    JSON.parse(readFileSync(join(root, 'signature', 'review', 'graph.json'), 'utf8')),
  );
  return { input, graph, selection: selectCandidates(graph) };
}

const answer = (edgeId: string, verdict: EdgeVerdict['verdict']): EdgeVerdict => ({
  edgeId,
  verdict,
  via: verdict === 'yes' ? 'direct' : null,
  reason: 'stub',
  citedLine: { path: 'src/fmt.ts', side: 'new', line: 8 },
});

const run = (
  hashes: Pick<ScoredRun, 'compatibilityHash' | 'promptHash'>,
  edgeVerdicts: EdgeVerdict[],
): ScoredRun => ({
  ...hashes,
  costUsd: 0.01,
  usage: {
    inputTokens: 10,
    outputTokens: 100,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 90,
  },
  output: { edgeVerdicts },
});

describe('adjudication scoring', () => {
  it("takes a fixture's truth from its withLsp facts", async () => {
    const { graph, selection } = await signatureReview();
    const truth = fixtureTruth(signature, graph);
    // The two candidates are the collisions the servers reject.
    expect(selection.open.map((e) => truth.get(e.id))).toEqual([false, false]);
    expect([...truth.values()].filter((t) => t === true)).toHaveLength(6);
  });

  it('scores precision, recall, false rejections and unsure answers', async () => {
    const { graph, selection } = await signatureReview();
    const [a, b] = selection.open;
    // Pretend one collision is real, to exercise every count.
    const truth = new Map([
      [a!.id, true],
      [b!.id, false],
    ]);
    expect(
      scoreVerdicts(selection, [answer(a!.id, 'yes'), answer(b!.id, 'no')], truth),
    ).toMatchObject({ asked: 2, scored: 2, real: 1, precision: 1, recall: 1, falseRejections: 0 });
    expect(
      scoreVerdicts(selection, [answer(a!.id, 'no'), answer(b!.id, 'yes')], truth),
    ).toMatchObject({ precision: 0, recall: 0, falseRejections: 1 });
    expect(scoreVerdicts(selection, [answer(a!.id, 'unsure')], truth)).toMatchObject({
      unsure: 1,
      missing: 1,
      precision: null,
      recall: 0,
    });
    expect(lspTruth(graph, graph).get(a!.id)).toBeNull();
  });

  it('counts identical answers and yes↔no flips across runs', async () => {
    const { selection } = await signatureReview();
    const [a, b] = selection.open;
    expect(
      consistency(selection, [
        [answer(a!.id, 'no'), answer(b!.id, 'no')],
        [answer(a!.id, 'no'), answer(b!.id, 'unsure')],
        [answer(a!.id, 'no'), answer(b!.id, 'yes')],
      ]),
    ).toEqual({ edges: 2, identical: 1, flips: 1 });
  });

  it('reports runs as a table, flagging stale ones', async () => {
    const { input, graph, selection } = await signatureReview();
    const verdicts = selection.open.map((e) => answer(e.id, 'no'));
    const hashes = { compatibilityHash: input.compatibilityHash, promptHash: input.promptHash };
    const report = reportRuns(
      { fixture: 'signature', model: 'stub', ...hashes },
      selection,
      fixtureTruth(signature, graph),
      [run(hashes, verdicts), run({ ...hashes, promptHash: 'sha256:old' }, verdicts)],
    );
    expect(report).toMatchObject({
      runs: 2,
      stale: 1,
      score: { asked: 4, scored: 4, no: { correct: 4, wrong: 0 }, precision: null },
      consistency: { edges: 2, identical: 2, flips: 0 },
      tokens: { input: 100, output: 100 },
    });
    expect(formatReports([report, report])).toContain(
      '| signature (1 stale) | stub | 2 | 4 | 4 | 0/0 | 4/0 | 0 | 0 | - | - | - | 2/2 | 0 | $0.0200 | 100/100 |',
    );
  });
});
