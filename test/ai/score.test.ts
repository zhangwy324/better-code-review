// The planner checks (score.ts, #26) on plans written by hand and on the fallback plans. No model.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fallbackPlan } from '../../src/planner/index.ts';
import { FIXTURES } from '../fixtures/index.ts';
import { signature } from '../fixtures/signature.ts';
import { modelInput } from './input.ts';
import { planFromLabels, scorePlan } from './score.ts';

const root = mkdtempSync(join(tmpdir(), 'bcr-score-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const failed = (checks: { name: string; ok: boolean }[]) =>
  checks.filter((c) => !c.ok).map((c) => c.name);

describe.each(FIXTURES)('the fallback plan for $name', (fixture) => {
  it('is valid and scored against every plan fact, but is not the agent', async () => {
    const { graph, files } = await modelInput('skill', fixture, join(root, fixture.name));
    // Throws if a plan fact names a node the graph doesn't have.
    const { checks } = await scorePlan(fixture, fallbackPlan(graph), graph, files);
    expect(checks.find((c) => c.name === 'valid')?.ok).toBe(true);
    expect(failed(checks)).toContain('agent');
  });
});

describe('scorePlan on the signature fixture', async () => {
  const { graph, files } = await modelInput('skill', signature, join(root, 'signature-hand'));
  const good = {
    'format-contract': ['formatPrice'],
    'format-callers': ['checkoutSummary', 'invoiceSummary', 'receiptSummary', 'aliasCaller'],
    'tax-contract': ['tax'],
    'tax-callers': ['order_total', 'refund'],
    unrelated: ['legacyLabel', 'viaMethod', 'use_calc', 'config.json'],
  };
  const score = (groups: Record<string, string[]>) =>
    scorePlan(signature, planFromLabels(graph, groups), graph, files);

  it('passes a plan with each contract before its callers', async () => {
    const { checks, verdicts } = await score(good);
    expect(failed(checks)).toEqual([]);
    expect(verdicts).toEqual({ possible: 8, yes: 0, no: 0, unsure: 0 });
  });

  it('fails callers read before their contract, across groups or within one', async () => {
    const rest = Object.fromEntries(
      Object.entries(good).filter(([id]) => id !== 'format-contract'),
    );
    const across = await score({ ...rest, 'format-contract': ['formatPrice'] });
    const [order] = across.checks.filter((c) => !c.ok);
    expect(order?.name).toMatch(/^order formatPrice → /);
    expect(order?.detail).toContain(
      'checkoutSummary (format-callers) is read before formatPrice (format-contract)',
    );

    const within = await score({
      ...rest,
      'format-callers': [...good['format-callers'], 'formatPrice'],
    });
    expect(failed(within.checks)).toEqual([expect.stringMatching(/^order formatPrice → /)]);
  });

  it('fails a same-name edit grouped with the callers', async () => {
    const { checks } = await score({
      ...good,
      'format-callers': [...good['format-callers'], 'viaMethod'],
      unrelated: ['legacyLabel', 'use_calc', 'config.json'],
    });
    expect(failed(checks)).toEqual([
      expect.stringMatching(/^apart formatPrice, .* \| legacyLabel/),
    ]);
  });

  it('fails a node left in Ungrouped', async () => {
    const { checks } = await score({
      ...good,
      unrelated: ['legacyLabel', 'viaMethod', 'use_calc'],
    });
    expect(checks.find((c) => c.name === 'homed')).toEqual({
      name: 'homed',
      ok: false,
      detail: 'config.json',
    });
  });

  it('fails an invented node and stops there', async () => {
    const { checks } = await score({ ...good, invented: ['n_0000000000000000'] });
    expect(checks).toEqual([
      { name: 'valid', ok: false, detail: expect.stringContaining('unknown-id') as string },
    ]);
  });
});
