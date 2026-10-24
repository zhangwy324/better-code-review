// The pipeline end to end through `run` (#34): `generate --local` on the signature fixture writes
// an openable review.html with the fallback plan, then an agent's plan replaces plan.json and
// `render` rewrites the page with it, as the skill does. "Openable" is checked as the viewer
// checks it when the page loads (src/viewer/data.ts): each embedded document matches its contract
// and all three are for the same snapshot. render.test.ts in src/renderer checks the page itself.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DefaultTreeAdapterMap, parse } from 'parse5';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFixtureRepo } from '../../test/fixtures/repo.ts';
import { signature } from '../../test/fixtures/signature.ts';
import { NO_AGENT_REASON } from '../planner/index.ts';
import { DATA_ELEMENT_IDS } from '../renderer/embed.ts';
import { buildViewer } from '../renderer/viewer.test-helper.ts';
import { parseContract } from '../schemas/contracts.ts';
import { UNGROUPED_GROUP_ID, type ReviewPlan } from '../schemas/plan.ts';
import { EXIT, run, type RunOptions } from './main.ts';

type Element = DefaultTreeAdapterMap['element'];
type ParentNode = DefaultTreeAdapterMap['parentNode'];

let tmp: string;
let viewerTemplate: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'bcr-pipeline-'));
  viewerTemplate = await buildViewer(join(tmp, 'viewer'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function cli(cwd: string, argv: string[], options: RunOptions = {}) {
  let stdout = '';
  let stderr = '';
  const exitCode = await run(
    argv,
    { cwd, out: (t) => (stdout += t), err: (t) => (stderr += t) },
    { viewerTemplate, ...options },
  );
  return { exitCode, stdout, stderr };
}

/** The signature fixture's change, uncommitted: HEAD is its base and the working tree its head. */
function localChange(name: string): string {
  const { repo } = buildFixtureRepo(join(tmp, name), signature, { checkout: true });
  repo.git('reset', '-q', 'base');
  return repo.path;
}

/** `generate --local` in `repo`, returning the review directory it reports. */
async function generateLocal(repo: string): Promise<string> {
  const result = await cli(repo, ['generate', '--local', '--no-lsp']);
  expect(result.stderr).not.toContain('error');
  expect(result.exitCode).toBe(EXIT.ok);
  const dir = /^Written to (.+)$/m.exec(result.stdout)![1]!;
  expect(dir).toMatch(/^\.better-code-review[/\\]reviews[/\\]local-[0-9a-f]{7}$/);
  return join(repo, dir);
}

function elements(node: ParentNode): Element[] {
  return node.childNodes.flatMap((child) =>
    'tagName' in child ? [child, ...elements(child)] : [],
  );
}

/** The documents in review.html, read and checked as the viewer does when the page opens. */
function openReview(path: string) {
  const all = elements(parse(readFileSync(path, 'utf8')));
  const embedded = (id: string): unknown => {
    const element = all.find((e) => e.attrs.some((a) => a.name === 'id' && a.value === id));
    expect(element, id).toBeDefined();
    return JSON.parse(element!.childNodes.map((c) => ('value' in c ? c.value : '')).join(''));
  };
  const changeSet = parseContract('change-set', embedded(DATA_ELEMENT_IDS.changes));
  const graph = parseContract('change-graph', embedded(DATA_ELEMENT_IDS.graph));
  const plan = parseContract('review-plan', embedded(DATA_ELEMENT_IDS.plan));
  expect(graph.snapshotId).toBe(changeSet.snapshotId);
  expect(plan.snapshotId).toBe(changeSet.snapshotId);
  // The viewer's script came through: it is what turns the data into the review.
  expect(all.filter((e) => e.tagName === 'script').map((s) => s.attrs[0]?.value)).toContain(
    'module',
  );
  return { changeSet, graph, plan };
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

describe('generate and render', () => {
  it('turn `local` into an openable review.html, with the fallback plan, then the agent plan', async () => {
    const repo = localChange('local');
    const dir = await generateLocal(repo);

    // generate alone: the page shows the fallback plan, and says so.
    const generated = openReview(join(dir, 'review.html'));
    expect(generated.changeSet.target.kind).toBe('local');
    expect(generated.changeSet.files.map((f) => f.newPath)).toContain('src/price.ts');
    expect(generated.plan).toEqual(readJson(join(dir, 'plan.json')));
    expect(generated.plan.fallbackReason).toBe(NO_AGENT_REASON);

    // The agent's plan: one group that leaves a node without a home.
    const [homeless, ...homed] = generated.graph.nodes.map((n) => n.id);
    const plan: ReviewPlan = {
      ...generated.plan,
      origin: 'agent',
      fallbackReason: null,
      summary: 'Formatting prices takes a currency.',
      groups: [
        {
          id: 'pricing',
          title: 'Price formatting',
          description: 'formatPrice and its callers.',
          nodeIds: homed,
          referenceNodeIds: [],
          childGroupIds: [],
        },
      ],
      groupOrder: ['pricing'],
    };
    writeFileSync(join(dir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);

    const rendered = await cli(repo, ['render', '--dir', dir]);
    expect(rendered.stderr).toBe('');
    expect(rendered.exitCode).toBe(EXIT.ok);
    expect(rendered.stdout).toBe(
      `Review written to ${join(dir, 'review.html').slice(repo.length + 1)}\n`,
    );
    // The page has the validated plan, with Ungrouped made; plan.json stays the agent's.
    const page = openReview(join(dir, 'review.html'));
    expect(page.changeSet).toEqual(generated.changeSet);
    expect(page.plan.groupOrder).toEqual(['pricing', UNGROUPED_GROUP_ID]);
    expect(page.plan.groups.find((g) => g.id === UNGROUPED_GROUP_ID)?.nodeIds).toEqual([homeless]);
    expect(readJson(join(dir, 'plan.json'))).toEqual(plan);

    // Rendering again gives the same bytes.
    const before = readFileSync(join(dir, 'review.html'), 'utf8');
    expect((await cli(repo, ['render', '--dir', dir])).exitCode).toBe(EXIT.ok);
    expect(readFileSync(join(dir, 'review.html'), 'utf8')).toBe(before);
  });

  it('render refuses an invalid plan and leaves the page as it was', async () => {
    const repo = localChange('invalid');
    const dir = await generateLocal(repo);
    const before = readFileSync(join(dir, 'review.html'), 'utf8');
    const plan = readJson(join(dir, 'plan.json')) as ReviewPlan;
    writeFileSync(join(dir, 'plan.json'), JSON.stringify({ ...plan, groupOrder: ['nope'] }));

    const result = await cli(repo, ['render', '--dir', dir]);
    expect(result.exitCode).toBe(EXIT.failed);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('plan.json is not valid, so review.html was not written');
    expect(result.stderr).toContain('  /groupOrder/0 unknown-id: group nope is not in groups\n');
    expect(readFileSync(join(dir, 'review.html'), 'utf8')).toBe(before);
  });

  it('render --open opens the page, and only reports a failure to open it', async () => {
    const repo = localChange('open');
    const dir = await generateLocal(repo);
    const opened: string[] = [];
    const ok = await cli(repo, ['render', '--dir', dir, '--open'], {
      open: (path) => {
        opened.push(path);
        return Promise.resolve();
      },
    });
    expect(ok.exitCode).toBe(EXIT.ok);
    expect(opened).toEqual([join(dir, 'review.html')]);

    const failed = await cli(repo, ['render', '--dir', dir, '--open'], {
      open: () => Promise.reject(new Error('spawn xdg-open ENOENT')),
    });
    expect(failed.exitCode).toBe(EXIT.ok);
    expect(failed.stderr).toBe('Could not open it: spawn xdg-open ENOENT\n');
  });
});
