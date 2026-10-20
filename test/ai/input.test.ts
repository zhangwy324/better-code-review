// The plan step's model input on every portfolio fixture: a deterministic hash, and a size
// ceiling so input bloat fails a normal test instead of a bill (#85). Sizes are `estimateTokens`
// (characters ÷ 4); no API is called.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FIXTURES } from '../fixtures/index.ts';
import { inputHash, modelInput } from './input.ts';

const root = mkdtempSync(join(tmpdir(), 'bcr-ai-input-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/**
 * Estimated tokens per fixture: the measured size plus about 10%. Raise one only after reading
 * why it grew (planner-input.md's selection policy is in src/planner/README.md).
 */
const CEILINGS: Record<string, number> = {
  signature: 2_250, // measured 2,021
  'ten-callers': 2_350, // 2,128
  'unchanged-caller': 800, // 723
  'removed-calls': 1_350, // 1,207
  'rename-move': 1_150, // 1,034
  'independent-roots': 1_000, // 893
  'feature-flow': 1_900, // 1,701
  'interface-impl': 2_500, // 2,238
  'override-dispatch': 950, // 839
  'override-dispatch-python': 950, // 837
  'same-name': 1_550, // 1,396
  'tests-and-config': 1_250, // 1,109
  'dynamic-calls': 1_100, // 965
  'unsupported-binary': 1_100, // 991
  'large-generated': 10_500, // 9,504
};

describe.each(FIXTURES)('plan input for $name', (fixture) => {
  it('has a stable hash and stays under its size ceiling', async () => {
    const input = await modelInput('plan', fixture, join(root, fixture.name));
    const again = await modelInput('plan', fixture, join(root, `${fixture.name}-again`));
    expect(again.inputHash).toBe(input.inputHash);
    const ceiling = CEILINGS[fixture.name];
    expect(ceiling, `add a size ceiling for ${fixture.name}`).toBeDefined();
    expect(input.estimatedTokens).toBeLessThanOrEqual(ceiling ?? 0);
  });
});

describe('inputHash', () => {
  it('changes with any part, its name or the order', () => {
    const base = inputHash([
      ['a', 'x'],
      ['b', 'y'],
    ]);
    expect(
      inputHash([
        ['a', 'x'],
        ['b', 'y'],
      ]),
    ).toBe(base);
    expect(
      inputHash([
        ['a', 'x'],
        ['b', 'z'],
      ]),
    ).not.toBe(base);
    expect(
      inputHash([
        ['a', 'x'],
        ['c', 'y'],
      ]),
    ).not.toBe(base);
    expect(
      inputHash([
        ['b', 'y'],
        ['a', 'x'],
      ]),
    ).not.toBe(base);
    expect(inputHash([['a', 'xb\0y']])).not.toBe(base);
  });
});
