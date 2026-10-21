// Scores the caller verdicts of recorded runs against ground truth (#43, test/ai/adjudication.ts).
// It reads files and calls no model, so it needs no approval; the runs it scores come from
// `npm run eval`, which does.
//
//   node scripts/score-adjudication.ts [--outputs <dir>]
//     Every plan `npm run eval` kept in <dir> (default .cache/eval/outputs/), per fixture and
//     model, against the fixture's `withLsp` facts.
//   node scripts/score-adjudication.ts --graph <graph.json> --truth <graph.json> <plan.json>…
//     Any change, e.g. a #42 pull request: the plans' verdicts on the `--graph` review (generated
//     with --no-lsp) against the same change generated with language servers (`--truth`).
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { selectCandidates } from '../src/planner/index.ts';
import { ChangeGraph } from '../src/schemas/index.ts';
import {
  fixtureTruth,
  formatReports,
  lspTruth,
  reportRuns,
  type RunsReport,
  type ScoredRun,
} from '../test/ai/adjudication.ts';
import { modelInput } from '../test/ai/input.ts';
import { Recording } from '../test/ai/recording.ts';
import { FIXTURES } from '../test/fixtures/index.ts';

const { values, positionals } = parseArgs({
  options: {
    outputs: { type: 'string' },
    graph: { type: 'string' },
    truth: { type: 'string' },
  },
  allowPositionals: true,
});
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

if (values.graph !== undefined || values.truth !== undefined) {
  if (values.graph === undefined || values.truth === undefined || positionals.length === 0) {
    console.error('Usage: --graph <graph.json> --truth <graph.json> <plan.json>…');
    process.exit(2);
  }
  const graph = ChangeGraph.parse(readJson(values.graph));
  const truth = lspTruth(graph, ChangeGraph.parse(readJson(values.truth)));
  const runs: ScoredRun[] = positionals.map((path) => ({
    inputHash: '',
    costUsd: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    output: readJson(path),
  }));
  const report = reportRuns(
    { fixture: values.graph, model: '-', inputHash: '' },
    selectCandidates(graph),
    truth,
    runs,
  );
  process.stdout.write(formatReports([report]));
} else {
  const dir = values.outputs ?? fileURLToPath(new URL('../.cache/eval/outputs/', import.meta.url));
  const byKey = new Map<string, Recording[]>();
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort()) {
    const run = Recording.parse(readJson(join(dir, name)));
    const key = JSON.stringify([run.fixture, run.model]);
    byKey.set(key, [...(byKey.get(key) ?? []), run]);
  }
  const reports: RunsReport[] = [];
  const work = mkdtempSync(join(tmpdir(), 'bcr-score-'));
  try {
    for (const [key, runs] of byKey) {
      const [fixtureName, model] = JSON.parse(key) as [string, string];
      const fixture = FIXTURES.find((f) => f.name === fixtureName);
      if (fixture === undefined) {
        console.error(`Skipping ${fixtureName}: not in the portfolio`);
        continue;
      }
      // One directory per (fixture, model): a fixture can have runs from several models.
      const fixtureDir = join(work, `${fixtureName}-${model}`);
      const input = await modelInput(runs[0]!.task as 'skill', fixture, fixtureDir);
      const graph = ChangeGraph.parse(readJson(join(fixtureDir, 'review', 'graph.json')));
      reports.push(
        reportRuns(
          { fixture: fixtureName, model, inputHash: input.inputHash },
          selectCandidates(graph),
          fixtureTruth(fixture, graph),
          runs,
        ),
      );
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (reports.length === 0) {
    console.error(`No runs in ${dir}. npm run eval keeps them there (it spends real AI usage).`);
    process.exit(1);
  }
  process.stdout.write(formatReports(reports));
}
