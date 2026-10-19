import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectLanguage, grammarFile, readManifest } from './languages.ts';

describe('detectLanguage', () => {
  it.each([
    ['src/pricing.ts', 'typescript'],
    ['src/types.d.ts', 'typescript'],
    ['lib/x.mts', 'typescript'],
    ['lib/x.cts', 'typescript'],
    ['ui/App.tsx', 'tsx'],
    ['index.js', 'javascript'],
    ['a/b.mjs', 'javascript'],
    ['a/b.cjs', 'javascript'],
    ['ui/App.jsx', 'javascript'],
    ['py/tax.py', 'python'],
    ['py/stubs.pyi', 'python'],
    ['src/main/java/A.java', 'java'],
    ['SRC/Upper.JAVA', 'java'],
  ])('%s is %s', (path, grammar) => {
    expect(detectLanguage(path)).toBe(grammar);
  });

  it.each([
    'main.go',
    'README.md',
    'package.json',
    'Makefile',
    '.ts',
    'dir.ts/file',
    'logo.png',
    'Main.kt',
  ])('%s has no built-in grammar', (path) => {
    expect(detectLanguage(path)).toBeNull();
  });
});

describe('grammars/manifest.json', () => {
  const manifest = readManifest();

  it('pins every built-in grammar once', () => {
    expect(manifest.grammars.map((g) => g.grammar).sort()).toEqual([
      'java',
      'javascript',
      'python',
      'tsx',
      'typescript',
    ]);
  });

  it('matches the installed engine', () => {
    const engine = JSON.parse(
      // package.json is not exported, so resolve the entry point and read its sibling.
      readFileSync(new URL('package.json', import.meta.resolve('web-tree-sitter')), 'utf8'),
    ) as { version: string };
    expect(manifest.engine).toBe(`web-tree-sitter@${engine.version}`);
  });

  it.each(manifest.grammars.map((g) => [g.grammar, g] as const))(
    '%s: vendored .wasm matches its sha256 and ships its licence',
    (grammar, pin) => {
      const digest = createHash('sha256')
        .update(readFileSync(grammarFile(grammar)))
        .digest('hex');
      expect(digest).toBe(pin.sha256);
      // The licence itself is checked against the policy by `npm run licenses`.
      expect(pin.license).toBeTruthy();
      expect(
        readFileSync(new URL(`grammars/${pin.licenseFile}`, import.meta.url), 'utf8'),
      ).not.toBe('');
    },
  );
});
