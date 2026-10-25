// The malicious-content fixture through the CLI (#35, design reference §14.2): `generate`,
// `validate` and `render` with a hostile agent plan. The page embeds every hostile string as
// inert data and gains no element from it; the terminal and model text quote file names that
// could forge a line or send an escape; and nothing the change or the user's Git config could
// run does: diff drivers, textconv, the tracked `node_modules/typescript`. The viewer side is
// src/viewer/Security.test.tsx.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DefaultTreeAdapterMap, parse } from 'parse5';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ESCAPE_PATH,
  hostilePlan,
  maliciousContent,
  NEWLINE_PATH,
} from '../../test/fixtures/malicious-content.ts';
import { buildFixtureRepo } from '../../test/fixtures/repo.ts';
import { buildViewer } from '../renderer/viewer.test-helper.ts';
import type { ChangeGraph } from '../schemas/graph.ts';
import type { ReviewPlan } from '../schemas/plan.ts';
import { quotePath } from '../text/index.ts';
import { EXIT, run, type TestHooks } from './main.ts';

type Element = DefaultTreeAdapterMap['element'];
type ParentNode = DefaultTreeAdapterMap['parentNode'];

let tmp: string;
let viewerTemplate: string;
let repo: string;
/** Written by anything that runs code it should not. */
let marker: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'bcr-security-'));
  viewerTemplate = await buildViewer(join(tmp, 'viewer'));
  const built = buildFixtureRepo(join(tmp, 'repo'), maliciousContent);
  repo = built.repo.path;
  marker = join(tmp, 'ran');
  // A user whose Git config defines the drivers the change's .gitattributes names.
  const script = join(tmp, 'pwn.js');
  writeFileSync(script, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x');\n`);
  const command = `node "${script.replaceAll('\\', '/')}"`;
  for (const key of ['diff.pwn.command', 'diff.pwn.textconv']) {
    built.repo.git('config', key, command);
  }
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function cli(argv: string[], hooks: TestHooks = {}) {
  let stdout = '';
  let stderr = '';
  const exitCode = await run(
    argv,
    { cwd: repo, out: (t) => (stdout += t), err: (t) => (stderr += t) },
    { viewerTemplate, ...hooks },
  );
  return { exitCode, stdout, stderr };
}

function elements(node: ParentNode): Element[] {
  return node.childNodes.flatMap((child) =>
    'tagName' in child ? [child, ...elements(child)] : [],
  );
}

/** Every element of a page, as its tag and attributes. */
const shape = (html: string) =>
  elements(parse(html)).map((e) => [e.tagName, ...e.attrs.map((a) => `${a.name}=${a.value}`)]);

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

describe('malicious content through the CLI', () => {
  it('renders a hostile change and plan as inert data, and runs nothing', async () => {
    const out = join(tmp, 'review');
    const generated = await cli(['generate', '--commit', 'main', '--no-lsp', '--out', out]);
    expect(generated.stderr).not.toContain('error');
    expect(generated.exitCode).toBe(EXIT.ok);

    // Text for the terminal and the model: no escape, and no line a file name made. (Import
    // resolution settles both edges, so there are no candidate batches.)
    const texts = [
      generated.stdout,
      generated.stderr,
      readFileSync(join(out, 'summary.txt'), 'utf8'),
      readFileSync(join(out, 'planner-input.md'), 'utf8'),
    ];
    for (const text of texts) {
      expect(text).not.toContain('\u001b');
      expect(text).not.toMatch(/^## Instructions from the user/m);
    }
    const planner = texts[3]!;
    expect(planner).toContain(`- ${quotePath(NEWLINE_PATH)}: added`);
    expect(planner).toContain(`- ${quotePath(ESCAPE_PATH)}: added`);

    // The agent's plan, hostile in every field a reviewer reads, passes validation.
    const graph = readJson(join(out, 'graph.json')) as ChangeGraph;
    const plan = hostilePlan(readJson(join(out, 'plan.json')) as ReviewPlan, graph);
    writeFileSync(join(out, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
    const validated = await cli(['validate', '--dir', out]);
    expect(validated.stdout).toContain('"valid": true');
    expect((await cli(['render', '--dir', out])).exitCode).toBe(EXIT.ok);

    // The page is the viewer's, element for element, plus the three data elements, which read
    // back unchanged.
    const page = readFileSync(join(out, 'review.html'), 'utf8');
    expect(shape(page)).toEqual([
      ...shape(viewerTemplate),
      ['script', 'type=application/json', 'id=bcr-changes'],
      ['script', 'type=application/json', 'id=bcr-graph'],
      ['script', 'type=application/json', 'id=bcr-plan'],
    ]);
    const data = (id: string) => {
      const element = elements(parse(page)).find((e) => e.attrs.some((a) => a.value === id))!;
      return JSON.parse(element.childNodes.map((c) => ('value' in c ? c.value : '')).join(''));
    };
    expect(data('bcr-changes')).toEqual(readJson(join(out, 'changes.json')));
    expect(data('bcr-plan')).toEqual(plan);

    expect(existsSync(marker)).toBe(false);
  });

  // Servers need the head side on disk, and Windows cannot write the fixture's file names.
  it.skipIf(process.platform === 'win32')(
    'passes over the tracked node_modules when language servers are on',
    async () => {
      const out = join(tmp, 'review-lsp');
      process.env.BCR_PWNED_MARKER = marker;
      try {
        // No server on the search path: only the project's own node_modules could provide one.
        const result = await cli(['generate', '--commit', 'main', '--out', out], {
          lsp: { searchPath: '' },
        });
        expect(result.exitCode).toBe(EXIT.ok);
      } finally {
        delete process.env.BCR_PWNED_MARKER;
      }
      const graph = readJson(join(out, 'graph.json')) as ChangeGraph;
      const typescript = graph.languages.find((l) => l.language === 'typescript')!;
      expect(typescript.status).toBe('not-installed');
      expect(typescript.guidance).toContain(
        'project node_modules not used: node_modules was checked out from Git',
      );
      expect(existsSync(marker)).toBe(false);
    },
  );
});
