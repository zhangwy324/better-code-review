import { describe, expect, it } from 'vitest';
import {
  analyse,
  SIGNATURE_BASE,
  SIGNATURE_HEAD,
} from '../analysis/semantic/fixture.test-helper.ts';
import { gitSnapshotFiles } from '../analysis/semantic/snapshot-files.ts';
import { buildGraph } from '../graph/build.ts';
import { MAX_SHOW_LINES, show, ShowError, type ShowQuery } from './show.ts';

const lines = (...l: string[]) => `${l.join('\n')}\n`;
const key = 'ghp_' + 'a'.repeat(36);

const head = {
  ...SIGNATURE_HEAD,
  'src/long.ts': lines(...Array.from({ length: MAX_SHOW_LINES + 10 }, (_, i) => `// ${i + 1}`)),
  'src/token.ts': lines(`export const token = '${key}';`),
  '.env': lines('TOKEN=hunter2'),
};

async function setup() {
  const { repo, changes, structure, evidence } = await analyse(SIGNATURE_BASE, head);
  const graph = buildGraph(changes, { structure, evidence });
  const run = (query: ShowQuery) =>
    show(changes, graph, gitSnapshotFiles(repo.path, changes), query);
  const node = (name: string) => graph.nodes.find((n) => n.displayName === name)!;
  return { changes, graph, run, node };
}

describe('show', () => {
  it('shows a node on both sides, with its edges', async () => {
    const { run, node } = await setup();
    const text = await run({ id: node('formatPrice').id });
    expect(text).toContain('formatPrice ← checkoutSummary: calls, possible');
    expect(text).toContain(
      'New side, src/price.ts:\n1  export function formatPrice(amount: number, currency',
    );
    expect(text).toContain(
      'Old side, src/price.ts:\n1  export function formatPrice(amount: number)',
    );
  });

  it('shows an edge with each hit and the lines around it', async () => {
    const { run, graph, node } = await setup();
    const edge = graph.codeEdges.find(
      (e) => e.granularity === 'entity' && e.from === node('aliasCaller').id,
    )!;
    const text = await run({ id: edge.id });
    expect(text).toContain('Hit on the new src/viaAlias.ts:4:');
    expect(text).toContain(
      'import-resolution confirmed: fmt resolves to src/price.ts::formatPrice',
    );
    expect(text).toContain("4    return fmt(1, 'USD');");
  });

  it('shows a hunk, redacted', async () => {
    const { run, changes } = await setup();
    const file = changes.files.find((f) => f.newPath === 'src/token.ts')!;
    const text = await run({ id: file.hunks[0]!.id });
    expect(text).toContain("+export const token = '[REDACTED:github-token]';");
    expect(text).not.toContain(key);
  });

  it('reads unchanged files from the snapshot, and caps long reads', async () => {
    const { run } = await setup();
    expect(await run({ file: 'src/reexport.ts', side: 'new', lines: null })).toContain(
      "1  export { formatPrice as fmt } from './price.ts';",
    );
    const long = await run({ file: 'src/long.ts', side: 'new', lines: null });
    expect(long).toContain(`${MAX_SHOW_LINES}  // ${MAX_SHOW_LINES}`);
    expect(long).toContain(`… 10 more lines; ask for them with --lines ${MAX_SHOW_LINES + 1}-`);
    const range = await run({ file: 'src/long.ts', side: 'new', lines: { start: 3, end: 4 } });
    expect(range).toBe('# src/long.ts, new side\n\n3  // 3\n4  // 4\n');
  });

  it('refuses sensitive files and unknown IDs', async () => {
    const { run, changes } = await setup();
    const env = changes.files.find((f) => f.newPath === '.env')!;
    expect(await run({ id: env.hunks[0]!.id })).toContain('Not shown: withheld: environment file.');
    expect(await run({ file: '.env', side: 'new', lines: null })).not.toContain('hunter2');
    await expect(run({ id: 'n_0000000000000000' })).rejects.toThrow(ShowError);
    await expect(run({ id: 'x_1' })).rejects.toThrow('is not a hunk');
    await expect(run({ file: 'missing.ts', side: 'new', lines: null })).rejects.toThrow(
      'no text content on the new side',
    );
  });
});
