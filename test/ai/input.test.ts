// The skill's model input on every portfolio fixture: deterministic hashes, and a size
// ceiling so input bloat fails a normal test instead of a bill (#85). Sizes are `estimateTokens`
// (characters ÷ 4); no API is called.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { FIXTURES } from '../fixtures/index.ts';
import { inputHash, modelInput, REFERENCES, SKILL_DIR } from './input.ts';

const root = mkdtempSync(join(tmpdir(), 'bcr-ai-input-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/**
 * Estimated tokens per fixture: the measured size plus about 10%. About 4,200 of each is the
 * skill (SKILL.md and its planning references), which every run reads. Raise one only after reading
 * why it grew (planner-input.md's selection policy is in src/planner/README.md).
 */
const CEILINGS: Record<string, number> = {
  signature: 7_600, // measured 6,897
  'ten-callers': 7_200, // 6,500
  'unchanged-caller': 5_500, // 4,995
  'removed-calls': 6_100, // 5,522
  'rename-move': 5_900, // 5,335
  'independent-roots': 5_700, // 5,165
  'feature-flow': 6_650, // 6,016
  'interface-impl': 8_550, // 7,772
  'override-dispatch': 6_200, // 5,608
  'override-dispatch-python': 6_200, // 5,600
  'same-name': 7_100, // 6,433
  'tests-and-config': 5_950, // 5,381
  'dynamic-calls': 5_800, // 5,238
  'unsupported-binary': 5_800, // 5,263
  'large-generated': 16_300, // 14,799
  'malicious-content': 6_850, // 6,221
};

describe.each(FIXTURES)('skill input for $name', (fixture) => {
  it('has stable hashes and stays under its size ceiling', async () => {
    const input = await modelInput('skill', fixture, join(root, fixture.name));
    const again = await modelInput('skill', fixture, join(root, `${fixture.name}-again`));
    expect(again.compatibilityHash).toBe(input.compatibilityHash);
    expect(again.promptHash).toBe(input.promptHash);
    const ceiling = CEILINGS[fixture.name];
    expect(ceiling, `add a size ceiling for ${fixture.name}`).toBeDefined();
    expect(input.estimatedTokens).toBeLessThanOrEqual(ceiling ?? 0);
  });
});

it('says of every skill reference whether the planner reads it', () => {
  const dir = fileURLToPath(new URL(`../../${SKILL_DIR}/references`, import.meta.url));
  expect(Object.keys(REFERENCES).sort()).toEqual(readdirSync(dir).sort());
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
