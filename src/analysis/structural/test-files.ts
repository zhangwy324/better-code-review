// Test and test-support file classification (#15, MVP spec D2). Path conventions and test roots
// declared in config decide; content (test-framework imports, test declarations) only breaks the
// tie when a path merely looks test-related, such as `src/testing/helpers.ts`. Misclassifying a
// file changes edge granularity only, never coverage.
//
// Config is read as text and never evaluated: a `jest.config.js` is code from the change under
// review, so only literal `testMatch` / `include` arrays are understood.
import { posix } from 'node:path';
import type { AnalyzedFile } from '../../schemas/structural.ts';

/** Test locations declared in the repository's config. */
export interface TestRoots {
  /** Directories, repository-relative, without a trailing `/`. */
  directories: string[];
  /** Globs (jest `testMatch`, vitest `include`), matched against the repository-relative path. */
  globs: string[];
  /** Regular expressions (jest `testRegex`). */
  patterns: RegExp[];
}

export const NO_TEST_ROOTS: TestRoots = { directories: [], globs: [], patterns: [] };

/** Reads a repository-relative file, or returns null when it does not exist. */
export type ReadFile = (path: string) => string | null;

const JS_CONFIG_EXTENSIONS = ['js', 'ts', 'mjs', 'mts', 'cjs', 'cts'];

/**
 * The test roots declared at the repository root: pytest `testpaths`, jest `testMatch` and
 * `testRegex`, vitest `include`, Maven `testSourceDirectory` and Gradle test source sets.
 * Nested projects' configs are not read.
 */
export function declaredTestRoots(read: ReadFile): TestRoots {
  const roots: TestRoots = { directories: [], globs: [], patterns: [] };

  // pytest: pyproject.toml, or an ini-style file.
  const pyproject = read('pyproject.toml');
  if (pyproject !== null) {
    const section = iniSection(pyproject, 'tool.pytest.ini_options');
    const value = section && /^\s*testpaths\s*=\s*(\[[^\]]*\]|"[^"]*"|'[^']*')/m.exec(section);
    if (value) roots.directories.push(...stringLiterals(value[1]!));
  }
  for (const [file, name] of [
    ['pytest.ini', 'pytest'],
    ['tox.ini', 'pytest'],
    ['setup.cfg', 'tool:pytest'],
  ] as const) {
    const text = read(file);
    const section = text === null ? null : iniSection(text, name);
    // The value may continue on indented lines.
    const value = section && /^testpaths\s*=([^\n]*(?:\n[ \t]+[^\n]*)*)/m.exec(section);
    if (value) roots.directories.push(...value[1]!.trim().split(/\s+/).filter(Boolean));
  }

  // jest: package.json, jest.config.json or a JS/TS config.
  const pkg = parseJson(read('package.json'));
  const jestJson = parseJson(read('jest.config.json'));
  for (const jest of [isObject(pkg) ? pkg['jest'] : undefined, jestJson]) {
    if (!isObject(jest)) continue;
    if (Array.isArray(jest['testMatch'])) roots.globs.push(...strings(jest['testMatch']));
    const testRegex = jest['testRegex'];
    roots.patterns.push(
      ...regexes(typeof testRegex === 'string' ? [testRegex] : strings(testRegex)),
    );
  }
  for (const ext of JS_CONFIG_EXTENSIONS) {
    const text = read(`jest.config.${ext}`);
    if (text === null) continue;
    const match = /\btestMatch\s*:\s*(\[[^\]]*\])/.exec(text);
    if (match) roots.globs.push(...stringLiterals(match[1]!));
    const regex = /\btestRegex\s*:\s*(['"`](?:\\.|[^\\'"`])*['"`])/.exec(text);
    if (regex) roots.patterns.push(...regexes(stringLiterals(regex[1]!)));
  }

  // vitest: `test: { include: […] }` in vitest.config.* or vite.config.*.
  for (const base of ['vitest.config', 'vite.config']) {
    for (const ext of JS_CONFIG_EXTENSIONS) {
      const text = read(`${base}.${ext}`);
      const test = text === null ? -1 : text.search(/\btest\s*:\s*\{/);
      if (text === null || test === -1) continue;
      const match = /\binclude\s*:\s*(\[[^\]]*\])/.exec(text.slice(test));
      if (match) roots.globs.push(...stringLiterals(match[1]!));
    }
  }

  // Maven. The default, src/test/java, is a path convention already.
  const pom = read('pom.xml');
  for (const m of pom?.matchAll(/<testSourceDirectory>\s*([^<]*?)\s*<\/testSourceDirectory>/g) ??
    []) {
    roots.directories.push(m[1]!.replace(/^\$\{(?:project\.)?basedir\}\//, ''));
  }

  // Gradle: `test { java { srcDirs = […] } }` and the like, in any source set named *test*.
  for (const file of ['build.gradle', 'build.gradle.kts']) {
    const text = read(file);
    if (text === null) continue;
    const block = /\b\w*[tT]est\w*\s*(?:\{|\(\s*\)\s*\{)\s*(?:java|kotlin|groovy)\s*\{([^{}]*)\}/g;
    for (const m of text.matchAll(block)) {
      for (const dirs of m[1]!.matchAll(/\b(?:setSrcDirs|srcDirs?)\b([^\n]*)/g)) {
        roots.directories.push(...stringLiterals(dirs[1]!));
      }
    }
  }

  roots.directories = [...new Set(roots.directories.map(normaliseDirectory))].filter(Boolean);
  roots.globs = [...new Set(roots.globs.map((g) => g.replace(/^(?:<rootDir>\/|\.\/)/, '')))];
  return roots;
}

/** Facts about a file's content, from its parsed side. Null when it was not parsed. */
export interface ContentSignals {
  imports: string[];
  /** A declaration matched a test convention (describe/it, pytest, JUnit). */
  testDeclarations: boolean;
}

/** Strong path conventions (D2): a match makes the file a test or test-support file. */
const TEST_FILE_NAME =
  /(?:\.(?:test|spec)\.[^/]+|^test_[^/]*\.pyi?|_test\.pyi?|^conftest\.py|(?:Test|Tests|IT)\.java)$/;
const TEST_DIRECTORIES = new Set(['test', 'tests', '__tests__', '__mocks__', 'spec']);
/** Words that make a path look test-related without settling it. */
const WEAK_WORDS = new Set([
  ...['test', 'tests', 'testing', 'spec', 'specs', 'mock', 'mocks', 'fixture', 'fixtures'],
  ...['stub', 'stubs', 'fake', 'fakes'],
]);
const TEST_FRAMEWORKS =
  /^(?:vitest|jest|@jest\/|mocha|chai|sinon|@testing-library\/|node:test|ava|jasmine|pytest|unittest|hypothesis|org\.junit|junit|org\.testng|org\.mockito|org\.assertj|org\.hamcrest)/;

export function classifyTestFile(
  path: string,
  roots: TestRoots,
  content: ContentSignals | null,
): AnalyzedFile['test'] {
  const segments = path.split('/');
  const name = segments.at(-1) ?? path;
  if (TEST_FILE_NAME.test(name) || segments.slice(0, -1).some((s) => TEST_DIRECTORIES.has(s))) {
    return 'path-convention';
  }
  if (
    roots.directories.some((d) => path.startsWith(`${d}/`)) ||
    roots.globs.some((g) => posix.matchesGlob(path, g)) ||
    roots.patterns.some((p) => p.test(path))
  ) {
    return 'declared-test-root';
  }
  const looksTestRelated = words(path).some((w) => WEAK_WORDS.has(w));
  if (
    looksTestRelated &&
    content !== null &&
    (content.testDeclarations || content.imports.some((i) => TEST_FRAMEWORKS.test(i)))
  ) {
    return 'content';
  }
  return null;
}

/** Lower-case words of a path, split at separators and camelCase humps. */
function words(path: string): string[] {
  return path
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** The body of an ini/TOML `[name]` section, or null. */
function iniSection(text: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(
    `^\\[${escaped}\\][^\\n]*\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`,
    'm',
  ).exec(text);
  return match ? match[1]! : null;
}

/** The values of the quoted strings in `text`, with backslash escapes resolved. */
function stringLiterals(text: string): string[] {
  return [...text.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)].map((m) =>
    m[2]!.replace(/\\(.)/g, '$1'),
  );
}

function parseJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Invalid expressions are dropped: they would not select any test for jest either. */
function regexes(sources: string[]): RegExp[] {
  return sources.flatMap((source) => {
    try {
      return [new RegExp(source)];
    } catch {
      return [];
    }
  });
}

function normaliseDirectory(dir: string): string {
  return dir.replace(/^\.\//, '').replace(/\/+$/, '');
}
