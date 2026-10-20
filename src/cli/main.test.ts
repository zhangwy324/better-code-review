import { describe, expect, it } from 'vitest';
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
