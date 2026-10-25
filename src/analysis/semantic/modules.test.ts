import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkoutRevision } from '../../git/checkout.ts';
import { TestRepo } from '../../git/test-repo.test-helper.ts';
import { linkInstalledModules, unlinkInstalledModules } from './modules.ts';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const PACKAGE = '{ "name": "app" }\n';

/** A repository whose one commit has a package.json, and a checkout of that commit. */
async function setUp(files: Record<string, string> = {}) {
  const repo = new TestRepo();
  const head = repo.commit([], { 'package.json': PACKAGE, 'a.ts': 'export {};\n', ...files });
  writeFileSync(join(repo.path, 'package.json'), PACKAGE);
  const dir = mkdtempSync(join(tmpdir(), 'bcr-modules-'));
  dirs.push(dir);
  const tree = join(dir, 'tree');
  await checkoutRevision(repo.path, head, tree);
  return { repo, head, tree };
}

function install(repo: TestRepo): void {
  mkdirSync(join(repo.path, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(repo.path, 'node_modules', 'dep', 'index.d.ts'), 'export const x: 1;\n');
}

describe('linkInstalledModules', () => {
  it("lends the checkout the working tree's own install, and unlinks only the link", async () => {
    const { repo, head, tree } = await setUp();
    install(repo);
    const modules = await linkInstalledModules(repo.path, head, tree, false);
    expect(modules).toEqual({ linkedFrom: repo.path, healthHint: null });
    expect(readFileSync(join(tree, 'node_modules', 'dep', 'index.d.ts'), 'utf8')).toContain('x');

    unlinkInstalledModules(tree, modules);
    expect(existsSync(join(tree, 'node_modules'))).toBe(false);
    expect(existsSync(join(repo.path, 'node_modules', 'dep', 'index.d.ts'))).toBe(true);
  });

  it("says when the revision's package.json differs from the working tree's", async () => {
    const { repo, head, tree } = await setUp();
    install(repo);
    writeFileSync(join(repo.path, 'package.json'), '{ "name": "app", "version": "2.0.0" }\n');
    const modules = await linkInstalledModules(repo.path, head, tree, false);
    expect(modules.linkedFrom).toBe(repo.path);
    expect(modules.healthHint).toMatch(/package\.json or lockfile differs/);
    unlinkInstalledModules(tree, modules);
  });

  it('asks for an install in the working tree when there is none, not in the checkout', async () => {
    const { repo, head, tree } = await setUp();
    const modules = await linkInstalledModules(repo.path, head, tree, false);
    expect(modules.linkedFrom).toBeNull();
    expect(modules.healthHint).toMatch(/Install the project's dependencies in the working tree/);
    expect(existsSync(join(tree, 'node_modules'))).toBe(false);
  });

  it('lends nothing from a node_modules Git tracks, unless project code is allowed', async () => {
    const { repo, head, tree } = await setUp();
    install(repo);
    repo.git('add', '-f', 'node_modules/dep/index.d.ts');
    const modules = await linkInstalledModules(repo.path, head, tree, false);
    expect(modules).toEqual({
      linkedFrom: null,
      healthHint: expect.stringMatching(
        /not lent to it, because node_modules is tracked by Git \(needs the project-code opt-in\)\. Installing dependencies would not change this\.$/,
      ) as string,
    });
    expect(existsSync(join(tree, 'node_modules'))).toBe(false);

    const allowed = await linkInstalledModules(repo.path, head, tree, true);
    expect(allowed.linkedFrom).toBe(repo.path);
    unlinkInstalledModules(tree, allowed);
  });

  it("leaves a revision's own node_modules to the session's check", async () => {
    const { repo, head, tree } = await setUp({ 'node_modules/dep/index.js': '' });
    install(repo);
    const modules = await linkInstalledModules(repo.path, head, tree, false);
    expect(modules).toEqual({ linkedFrom: null, healthHint: null });
    unlinkInstalledModules(tree, modules);
    expect(existsSync(join(tree, 'node_modules', 'dep', 'index.js'))).toBe(true);
  });
});
