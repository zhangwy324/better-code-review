// The skill's model input on every portfolio fixture: a deterministic hash, and a size
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
 * Estimated tokens per fixture: the measured size plus about 10%. About 3,800 of each is the
 * skill (SKILL.md and its references), which every run reads. Raise one only after reading
 * why it grew (planner-input.md's selection policy is in src/planner/README.md).
 */
const CEILINGS: Record<string, number> = {
  signature: 6_450, // measured 5,857
  'ten-callers': 6_600, // 5,964
  'unchanged-caller': 5_050, // 4,559
  'removed-calls': 5_550, // 5,043
  'rename-move': 5_400, // 4,870
  'independent-roots': 5_250, // 4,729
  'feature-flow': 6_100, // 5,537
  'interface-impl': 6_700, // 6,074
  'override-dispatch': 5_150, // 4,675
  'override-dispatch-python': 5_150, // 4,673
  'same-name': 5_800, // 5,232
  'tests-and-config': 5_450, // 4,945
  'dynamic-calls': 5_300, // 4,801
  'unsupported-binary': 5_350, // 4,827
  'large-generated': 14_700, // 13,340
};

describe.each(FIXTURES)('skill input for $name', (fixture) => {
  it('has a stable hash and stays under its size ceiling', async () => {
    const input = await modelInput('skill', fixture, join(root, fixture.name));
    const again = await modelInput('skill', fixture, join(root, `${fixture.name}-again`));
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
