import { describe, expect, it } from 'vitest';
import { NO_TEST_ROOTS, classifyTestFile, declaredTestRoots } from './test-files.ts';

const reader = (files: Record<string, string>) => (path: string) => files[path] ?? null;

describe('classifyTestFile', () => {
  it('recognises path conventions', () => {
    for (const path of [
      'src/price.test.ts',
      'src/price.spec.tsx',
      'src/__tests__/price.ts',
      'src/__mocks__/fs.ts',
      'test/helpers.js',
      'tests/test_price.py',
      'pkg/test_price.py',
      'pkg/price_test.py',
      'pkg/conftest.py',
      'core/src/test/java/shop/PriceTest.java',
      'shop/PriceTests.java',
      'shop/PriceIT.java',
    ]) {
      expect(classifyTestFile(path, NO_TEST_ROOTS, null), path).toBe('path-convention');
    }
    for (const path of ['src/price.ts', 'src/latest.ts', 'src/contest.py', 'shop/Testimony.java']) {
      expect(classifyTestFile(path, NO_TEST_ROOTS, null), path).toBeNull();
    }
  });

  it('uses declared test roots', () => {
    const roots = { directories: ['qa'], globs: ['**/*.check.ts'], patterns: [/\/e2e\//] };
    expect(classifyTestFile('qa/run.py', roots, null)).toBe('declared-test-root');
    expect(classifyTestFile('src/a.check.ts', roots, null)).toBe('declared-test-root');
    expect(classifyTestFile('app/e2e/flow.ts', roots, null)).toBe('declared-test-root');
    expect(classifyTestFile('qaz/run.py', roots, null)).toBeNull();
  });

  it('lets content break ties only on test-related paths', () => {
    const vitest = { imports: ['vitest'], testDeclarations: false };
    const plain = { imports: ['./price'], testDeclarations: false };
    expect(classifyTestFile('src/testing/clock.ts', NO_TEST_ROOTS, vitest)).toBe('content');
    expect(classifyTestFile('src/testUtils.ts', NO_TEST_ROOTS, vitest)).toBe('content');
    expect(
      classifyTestFile('src/fixtures.py', NO_TEST_ROOTS, {
        imports: ['pytest'],
        testDeclarations: false,
      }),
    ).toBe('content');
    expect(classifyTestFile('src/testing/clock.ts', NO_TEST_ROOTS, plain)).toBeNull();
    // Production code may import a test framework (a test helper library, say).
    expect(classifyTestFile('src/matchers.ts', NO_TEST_ROOTS, vitest)).toBeNull();
  });
});

describe('declaredTestRoots', () => {
  it('reads nothing from an empty repository', () => {
    expect(declaredTestRoots(reader({}))).toEqual(NO_TEST_ROOTS);
  });

  it('reads pytest testpaths', () => {
    expect(
      declaredTestRoots(
        reader({
          'pyproject.toml':
            '[project]\nname = "x"\n\n[tool.pytest.ini_options]\ntestpaths = ["checks", "./integration/"]\n',
          'setup.cfg': '[tool:pytest]\ntestpaths =\n    suite\n    more\n[flake8]\nx = 1\n',
        }),
      ).directories,
    ).toEqual(['checks', 'integration', 'suite', 'more']);
    expect(
      declaredTestRoots(reader({ 'pytest.ini': '[pytest]\ntestpaths = a b\n' })).directories,
    ).toEqual(['a', 'b']);
  });

  it('reads jest and vitest patterns without running config code', () => {
    const roots = declaredTestRoots(
      reader({
        'package.json': JSON.stringify({ jest: { testMatch: ['<rootDir>/qa/**/*.ts'] } }),
        'jest.config.ts': "export default { testRegex: '/e2e/.*\\\\.ts$' };",
        'vitest.config.mts':
          "export default defineConfig({ resolve: { include: ['nope'] }, test: { include: ['checks/**/*.ts'] } });",
      }),
    );
    expect(roots.globs).toEqual(['qa/**/*.ts', 'checks/**/*.ts']);
    expect(roots.patterns.map(String)).toEqual([String(/\/e2e\/.*\.ts$/)]);
  });

  it('reads Maven and Gradle test source directories', () => {
    const roots = declaredTestRoots(
      reader({
        'pom.xml':
          '<project><build><testSourceDirectory>${project.basedir}/qa/java</testSourceDirectory></build></project>',
        'build.gradle.kts':
          'sourceSets {\n  test {\n    java {\n      setSrcDirs(listOf("checks/java"))\n    }\n  }\n  main { java { srcDirs("src") } }\n}\n',
      }),
    );
    expect(roots.directories).toEqual(['qa/java', 'checks/java']);
  });
});
