import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluate, type LicensePolicy } from './license-policy.ts';
import policyJson from './license-policy.json' with { type: 'json' };

const policy: LicensePolicy = {
  allowed: ['MIT', 'ISC', 'Apache-2.0'],
  approvedExceptions: [
    { package: 'elkjs', license: 'EPL-2.0', approvedIn: '#30', obligations: 'unmodified' },
  ],
};

const dep = (licenses: string[], name = 'pkg') => ({ name, version: '1.0.0', licenses });

describe('evaluate', () => {
  it('allows allowlisted licences', () => {
    expect(evaluate(dep(['MIT']), policy)).toEqual({ ok: true, via: 'allowed' });
  });

  it('allows a dual licence when one option is allowed', () => {
    expect(evaluate(dep(['(MIT OR GPL-3.0-or-later)']), policy).ok).toBe(true);
  });

  it('requires every part of an AND expression to be allowed', () => {
    expect(evaluate(dep(['MIT AND Apache-2.0']), policy).ok).toBe(true);
    expect(evaluate(dep(['MIT AND GPL-3.0-only']), policy).ok).toBe(false);
  });

  it('rejects copyleft and review-required licences', () => {
    expect(evaluate(dep(['GPL-3.0-only']), policy).ok).toBe(false);
    expect(evaluate(dep(['MPL-2.0']), policy).ok).toBe(false);
  });

  it('rejects missing, unknown and unparseable licences', () => {
    expect(evaluate(dep([]), policy)).toEqual({ ok: false, reason: 'no licence found' });
    expect(evaluate(dep(['UNKNOWN']), policy).ok).toBe(false);
    expect(evaluate(dep(['UNLICENSED']), policy).ok).toBe(false);
    expect(evaluate(dep(['Custom: https://example.com']), policy).ok).toBe(false);
  });

  it('accepts licences guessed from a file (trailing *)', () => {
    expect(evaluate(dep(['ISC*']), policy).ok).toBe(true);
  });

  it('requires every reported licence to pass when several are reported', () => {
    expect(evaluate(dep(['MIT', 'GPL-2.0-only']), policy).ok).toBe(false);
  });

  it('applies approved exceptions only to the named package', () => {
    const elk = '(EPL-2.0 OR GPL-3.0-or-later)';
    expect(evaluate(dep([elk], 'elkjs'), policy)).toEqual({ ok: true, via: 'exception' });
    expect(evaluate(dep([elk], 'other'), policy).ok).toBe(false);
  });

  it('policy file matches the Allowed row in ADR 0002', () => {
    const adr = readFileSync(
      new URL('../docs/adr/0002-project-license.md', import.meta.url),
      'utf8',
    );
    const row = adr.split('\n').find((line) => line.startsWith('| **Allowed** |'));
    const cell = row?.split('|')[2]?.trim();
    expect(cell?.split(', ')).toEqual(policyJson.allowed);
  });
});
