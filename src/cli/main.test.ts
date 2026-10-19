import { describe, expect, it } from 'vitest';
import { run, version } from './main.ts';

describe('cli', () => {
  it('prints the package version', () => {
    expect(run(['--version'])).toEqual({ exitCode: 0, stdout: `${version()}\n`, stderr: '' });
    expect(version()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('prints usage by default', () => {
    const result = run([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: better-code-review');
  });

  it('rejects unknown options with exit code 2', () => {
    const result = run(['--nope']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Usage: better-code-review');
  });
});
