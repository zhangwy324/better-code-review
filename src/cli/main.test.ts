import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  analyse,
  SIGNATURE_BASE,
  SIGNATURE_HEAD,
} from '../analysis/semantic/fixture.test-helper.ts';
import { buildGraph } from '../graph/build.ts';
import { PLAN_SCHEMA_VERSION, type ReviewPlan } from '../schemas/plan.ts';
import { EXIT, parseRange, run, version } from './main.ts';

async function cli(...argv: string[]) {
  let stdout = '';
  let stderr = '';
  const exitCode = await run(argv, {
    cwd: process.cwd(),
    out: (t) => (stdout += t),
    err: (t) => (stderr += t),
  });
  return { exitCode, stdout, stderr };
}

describe('cli', () => {
  it('prints the package version', async () => {
    expect(await cli('--version')).toEqual({ exitCode: 0, stdout: `${version()}\n`, stderr: '' });
    expect(version()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('prints usage by default and for generate --help', async () => {
    for (const argv of [[], ['generate', '--help']]) {
      const result = await cli(...argv);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Usage: better-code-review');
    }
  });

  it('rejects unknown options with exit code 2', async () => {
    const result = await cli('--nope');
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain('Usage: better-code-review');
  });

  it.each([
    [[], 'generate needs a target'],
    [['--local', '--commit', 'HEAD'], 'Choose one target, not --local and --commit'],
    [['--pr', '0'], '--pr must be a positive whole number, got 0'],
    [['--pr', '1x'], '--pr must be a positive whole number'],
    [['--commit', 'HEAD', '--parent', '-1'], '--parent'],
    [['--local', '--parent', '2'], '--parent only applies to --commit'],
    [['--commit', 'HEAD', '--no-untracked'], '--no-untracked only applies to --local'],
    [['--range', 'main'], '--range must look like'],
    [['--range', '..'], '--range must look like'],
    [['--local', 'extra'], "Unexpected argument 'extra'"],
    [['--local', '--depth', 'deep'], "Unknown option '--depth'"],
  ])('rejects generate %j with exit code 2', async (argv, message) => {
    const result = await cli('generate', ...argv);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain(message);
  });
});

describe('show usage', () => {
  it.each([
    [['h_0000000000000000'], 'show needs --dir'],
    [['--dir', 'd'], 'show needs exactly one ID, or --file <path>'],
    [['--dir', 'd', 'h_1', '--file', 'a.ts'], 'show needs exactly one ID, or --file <path>'],
    [['--dir', 'd', 'h_1', '--lines', '1-2'], '--side and --lines only apply to --file'],
    [['--dir', 'd', 'h_1', '--side=old'], '--side and --lines only apply to --file'],
    [['--dir', 'd', '--file', 'a.ts', '--side', 'both'], '--side must be old or new'],
    [['--dir', 'd', '--file', '../a.ts'], '--file must be a repository-relative path'],
    [['--dir', 'd', '--file', 'a.ts', '--lines', '5-2'], '--lines must look like 10-40'],
  ])('rejects show %j with exit code 2', async (argv, message) => {
    const result = await cli('show', ...argv);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain(message);
  });
});

describe('parseRange', () => {
  it('reads direct and merge-base ranges, with HEAD for an empty end', () => {
    expect(parseRange('main..feature')).toEqual({
      kind: 'range',
      base: 'main',
      head: 'feature',
      mode: 'direct',
    });
    expect(parseRange('main...feature')).toMatchObject({ mode: 'merge-base' });
    expect(parseRange('main..')).toMatchObject({ base: 'main', head: 'HEAD' });
    expect(parseRange('...topic')).toMatchObject({
      base: 'HEAD',
      head: 'topic',
      mode: 'merge-base',
    });
  });
});

describe('validate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bcr-validate-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, data: unknown) =>
    writeFileSync(join(dir, name), typeof data === 'string' ? data : JSON.stringify(data));

  /** Writes changes.json and graph.json for the signature fixture; returns an empty plan. */
  async function setUp(): Promise<ReviewPlan> {
    const { changes, structure, evidence } = await analyse(SIGNATURE_BASE, SIGNATURE_HEAD);
    const graph = buildGraph(changes, { structure, evidence });
    write('changes.json', changes);
    write('graph.json', graph);
    return {
      schemaVersion: PLAN_SCHEMA_VERSION,
      snapshotId: graph.snapshotId,
      origin: 'agent',
      fallbackReason: null,
      summary: '',
      groups: [],
      groupOrder: [],
      edgeVerdicts: [],
      inferredRelationships: [],
    };
  }

  it('prints a JSON report, exiting 1 for an invalid plan', async () => {
    const plan = await setUp();
    write('plan.json', plan);
    const ok = await cli('validate', '--dir', dir);
    expect(ok.exitCode).toBe(EXIT.ok);
    // The fixture's commits are not in this repository, so the CLI says it reads changed files only.
    expect(ok.stderr).toContain('only changed files can be read');
    const report = JSON.parse(ok.stdout) as { valid: boolean; ungroupedNodeIds: string[] };
    expect(report.valid).toBe(true);
    expect(report.ungroupedNodeIds.length).toBeGreaterThan(0);

    write('other.json', { ...plan, groupOrder: ['nope'] });
    const bad = await cli('validate', '--dir', dir, '--plan', join(dir, 'other.json'));
    expect(bad.exitCode).toBe(EXIT.failed);
    expect(JSON.parse(bad.stdout)).toEqual({
      valid: false,
      errors: [
        { path: '/groupOrder/0', code: 'unknown-id', message: 'group nope is not in groups' },
      ],
    });

    write('plan.json', '{ not json');
    const broken = await cli('validate', '--dir', dir);
    expect(broken.exitCode).toBe(EXIT.failed);
    expect(JSON.parse(broken.stdout)).toMatchObject({ valid: false, errors: [{ code: 'json' }] });
  });

  it('needs --dir', async () => {
    const result = await cli('validate');
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain('validate needs --dir');
  });
});
