// Keeps the Agent Skill (#25) in step with the CLI it drives: its frontmatter follows the Agent
// Skills conventions, every CLI flag it names exists, its links resolve, and its repair table
// covers every validator error code.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../../src/cli/main.ts';
import { REPO_ROOT, SKILL_DIR, SKILL_NAME } from '../paths.ts';

const SKILL = join(REPO_ROOT, SKILL_DIR);
const DOCS = ['SKILL.md', ...readdirSync(join(SKILL, 'references')).map((f) => `references/${f}`)];
const read = (path: string) => readFileSync(join(SKILL, path), 'utf8').replaceAll('\r\n', '\n');

/** Flags the skill names that belong to other tools (Git's `status --porcelain`). */
const OTHER_TOOLS_FLAGS = new Set(['--porcelain']);

describe(SKILL_DIR, () => {
  it('has Agent Skills frontmatter', () => {
    const match = /^---\n([\s\S]*?)\n---\n/.exec(read('SKILL.md'));
    expect(match).not.toBeNull();
    const fields = new Map(
      match![1]!.split('\n').map((line) => {
        const i = line.indexOf(': ');
        return [line.slice(0, i), line.slice(i + 2)] as const;
      }),
    );
    expect(fields.get('name')).toBe(SKILL_NAME);
    const description = fields.get('description') ?? '';
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect((fields.get('compatibility') ?? '').length).toBeLessThanOrEqual(500);
  });

  it.each(DOCS)('%s names only CLI flags that exist', async (doc) => {
    let usage = '';
    await run(['--help'], { cwd: REPO_ROOT, out: (t) => (usage += t), err: () => {} });
    const flags = new Set(read(doc).match(/--[a-z][a-z-]*/g));
    for (const flag of flags) {
      if (!OTHER_TOOLS_FLAGS.has(flag)) expect(usage, flag).toMatch(new RegExp(`${flag}\\b`));
    }
  });

  it.each(DOCS)('%s links only to files that exist', (doc) => {
    for (const [, target] of read(doc).matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
      expect(existsSync(join(SKILL, dirname(doc), target!)), target).toBe(true);
    }
  });

  it('explains every validator error code', () => {
    const source = readFileSync(join(REPO_ROOT, 'src/planner/validate.ts'), 'utf8');
    const union = /export type PlanErrorCode =([^;]+);/.exec(source)![1]!;
    const codes = [...union.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!);
    expect(codes.length).toBeGreaterThan(0);
    const workflow = read('references/analysis-workflow.md');
    for (const code of codes) expect(workflow, code).toContain(`| \`${code}\` |`);
  });
});
