// @vitest-environment jsdom
// The app shell on a real fixture's data (#27 acceptance: loads fixture JSON and shows the header
// and outline with no network access), shared selection, and inert rendering of untrusted text.
// `generate` runs in a child process: jsdom replaces Node's URL, which the analyzers need.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildFixtureRepo } from '../../test/fixtures/repo.ts';
import { signature } from '../../test/fixtures/signature.ts';
import { App } from './App.tsx';
import { loadReviewData, type ReviewData } from './data.ts';
import { dataScripts } from '../renderer/embed.ts';
import { canvasGraph, changeItemId, groupItemId } from './canvas.ts';
import { UNCHANGED_CALLERS_NOTE } from './Canvas.tsx';
import { buildModel, hunkHeader } from './model.ts';

const root = mkdtempSync(join(tmpdir(), 'bcr-viewer-'));
let data: ReviewData;

beforeAll(() => {
  const { head } = buildFixtureRepo(join(root, 'repo'), signature);
  const out = join(root, 'out');
  const main = join(import.meta.dirname, '..', 'cli', 'main.ts');
  execFileSync(process.execPath, [main, 'generate', '--commit', head, '--no-lsp', '--out', out], {
    cwd: join(root, 'repo'),
    stdio: 'ignore',
  });
  const read = (file: string): unknown => JSON.parse(readFileSync(join(out, file), 'utf8'));
  data = {
    changeSet: read('changes.json') as ReviewData['changeSet'],
    graph: read('graph.json') as ReviewData['graph'],
    plan: read('plan.json') as ReviewData['plan'],
  };
  // jsdom has no ResizeObserver; the panel library only needs it to exist.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // Nor DOMMatrixReadOnly, which React Flow reads the zoom from (its testing guide does the same).
  globalThis.DOMMatrixReadOnly ??= class {
    m22 = 1;
  } as unknown as typeof DOMMatrixReadOnly;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/** Embeds `documents` in the page as review.html would, then loads and renders them. */
function renderEmbedded(documents: { changes: unknown; graph: unknown; plan: unknown }) {
  document.body.innerHTML = dataScripts(documents);
  return render(<App result={loadReviewData(document)} />);
}

const embedded = (d: ReviewData = data) => ({ changes: d.changeSet, graph: d.graph, plan: d.plan });

describe('App', () => {
  it('shows the header and outline from the embedded data with no network access', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const open = vi.spyOn(XMLHttpRequest.prototype, 'open');
    renderEmbedded(embedded());

    const header = screen.getByRole('banner');
    const { changeSet, plan } = data;
    expect(header.textContent).toContain(`commit ${changeSet.headRevision!.slice(0, 7)}`);
    expect(header.textContent).toContain(`snapshot ${changeSet.snapshotId.slice(0, 12)}`);
    const hunks = changeSet.files.flatMap((f) => f.hunks).length;
    expect(header.textContent).toContain(`${hunks}/${hunks} hunks mapped`);

    const outline = screen.getByRole('navigation', { name: 'Review outline' });
    for (const group of plan.groups) expect(within(outline).getByText(group.title)).toBeTruthy();
    for (const node of data.graph.nodes) {
      expect(within(outline).getAllByText(node.displayName).length).toBeGreaterThan(0);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('shares one selection between the outline, canvas and detail pane', () => {
    renderEmbedded(embedded());
    const outline = screen.getByRole('navigation', { name: 'Review outline' });
    const canvas = screen.getByRole('region', { name: 'Canvas' });
    const detail = screen.getByRole('region', { name: 'Selected change' });
    const group = data.plan.groups.find((g) => g.nodeIds.length > 1)!;
    const node = data.graph.nodes.find((n) => n.id === group.nodeIds[1])!;

    fireEvent.click(within(outline).getByText(group.title));
    expect(within(detail).getByRole('heading').textContent).toBe(group.title);
    expect(canvas.querySelector('.canvas-cluster[aria-current]')!.textContent).toContain(
      group.title,
    );

    fireEvent.click(within(canvas).getByText(node.displayName));
    expect(within(detail).getAllByRole('heading')[0]!.textContent).toBe(node.displayName);
    const current = outline.querySelectorAll('[aria-current]');
    expect([...current].map((e) => e.textContent)).toEqual([node.displayName]);

    const hunk = data.changeSet.files
      .flatMap((f) => f.hunks)
      .find((h) => h.id === node.hunkIds[0])!;
    fireEvent.click(within(detail).getByText(hunkHeader(hunk)));
    const shown = detail.querySelectorAll(`tbody[data-hunk-id="${hunk.id}"]`);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.querySelector('.hunk-header')!.textContent).toBe(hunk.patch.split('\n')[0]);
  });

  it('renders repository and plan text as text, never as HTML', () => {
    const attack = '<img src=x onerror="globalThis.pwned=1"><script>globalThis.pwned=1</script>';
    const plan = {
      ...data.plan,
      summary: attack,
      groups: data.plan.groups.map((g, i) => (i === 0 ? { ...g, title: attack } : g)),
    };
    const graph = {
      ...data.graph,
      nodes: data.graph.nodes.map((n, i) => (i === 0 ? { ...n, displayName: attack } : n)),
    };
    const { container } = renderEmbedded(embedded({ ...data, plan, graph }));

    expect(container.querySelector('img, script')).toBeNull();
    expect(screen.getAllByText(attack).length).toBeGreaterThanOrEqual(3);
    expect((globalThis as { pwned?: unknown }).pwned).toBeUndefined();
  });
});

// #30 acceptance: the root change points to its changed callers; the unchanged caller is absent.
describe('Canvas', () => {
  const nodeId = (name: string) => data.graph.nodes.find((n) => n.displayName === name)?.id;
  const callers = ['checkoutSummary', 'invoiceSummary', 'receiptSummary'];

  it('starts with one collapsed node per group, in reading order', () => {
    const model = buildModel(data);
    const { items } = canvasGraph(model, new Set());
    expect(items.map((i) => [i.type, i.id])).toEqual(
      data.plan.groupOrder.map((id) => ['collapsed', groupItemId(id)]),
    );
    expect(items.map((i) => i.data)).toEqual(
      data.plan.groupOrder.map((groupId, i) => ({ groupId, order: i + 1 })),
    );
    // Laid out apart, not on top of each other.
    const positions = new Set(items.map((i) => `${i.position.x},${i.position.y}`));
    expect(positions.size).toBe(items.length);
  });

  it('draws the root change to its changed callers, and no unchanged caller', () => {
    const model = buildModel(data);
    const { items, edges } = canvasGraph(model, new Set(data.plan.groupOrder));
    expect(nodeId('emailSummary')).toBeUndefined();
    expect(items.filter((i) => i.type === 'change')).toHaveLength(data.graph.nodes.length);

    const root = changeItemId(nodeId('formatPrice')!);
    for (const caller of callers) {
      const edge = edges.find((e) => e.target === changeItemId(nodeId(caller)!));
      expect(edge).toMatchObject({
        source: root,
        data: { style: 'possible', label: 'called by' },
      });
    }
    // Every member sits inside its group's box.
    for (const item of items.filter((i) => i.type === 'change')) {
      const home = model.homeGroup.get(item.data.nodeId)!;
      expect(item.parentId).toBe(groupItemId(home.id));
    }
  });

  it('aggregates the edges between collapsed groups', () => {
    const root = nodeId('formatPrice')!;
    const plan = {
      ...data.plan,
      groups: [
        ...data.plan.groups.map((g) => ({ ...g, nodeIds: g.nodeIds.filter((id) => id !== root) })),
        { ...data.plan.groups[0]!, id: 'contract', title: 'Contract', nodeIds: [root] },
      ],
      groupOrder: ['contract', ...data.plan.groupOrder],
    };
    const model = buildModel({ ...data, plan });
    const home = model.homeGroup.get(nodeId('checkoutSummary')!)!;
    const callerEdges = data.graph.codeEdges.filter(
      (e) => e.to === root && model.homeGroup.get((e as { from: string }).from) === home,
    );

    const { edges } = canvasGraph(model, new Set());
    expect(edges).toEqual([
      expect.objectContaining({
        source: groupItemId('contract'),
        target: groupItemId(home.id),
        data: {
          linkIds: callerEdges.map((e) => e.id),
          style: 'possible',
          label: `called by ×${callerEdges.length}`,
        },
      }),
    ]);
  });

  it('says that unchanged callers are not analysed, and expands groups on demand', () => {
    renderEmbedded(embedded());
    const canvas = screen.getByRole('region', { name: 'Canvas' });
    expect(within(canvas).getByText(UNCHANGED_CALLERS_NOTE)).toBeTruthy();
    for (const group of data.plan.groups)
      expect(within(canvas).getByText(group.title)).toBeTruthy();
    expect(within(canvas).queryByText('formatPrice')).toBeNull();

    const group = model().homeGroup.get(nodeId('formatPrice')!)!;
    fireEvent.click(within(canvas).getByLabelText(`Expand ${group.title}`));
    for (const name of ['formatPrice', ...callers]) {
      expect(within(canvas).getByText(name)).toBeTruthy();
    }
    expect(within(canvas).queryByText('emailSummary')).toBeNull();
    fireEvent.click(within(canvas).getByLabelText(`Collapse ${group.title}`));
    expect(within(canvas).queryByText('formatPrice')).toBeNull();
  });

  it('navigates along edges and shows their evidence and direction', () => {
    renderEmbedded(embedded());
    const outline = screen.getByRole('navigation', { name: 'Review outline' });
    const detail = screen.getByRole('region', { name: 'Selected change' });
    fireEvent.click(within(outline).getByText('checkoutSummary'));

    const related = within(detail).getByText('Related changes').nextElementSibling as HTMLElement;
    expect(related.textContent).toBe('calls formatPrice possible');
    fireEvent.click(within(related).getByText('possible'));
    expect(within(detail).getAllByRole('heading')[0]!.textContent).toBe(
      'checkoutSummary calls formatPrice',
    );
    expect(detail.textContent).toContain('Possible: found by text search, not verified');
    expect(detail.textContent).toMatch(
      /text-search · candidate · call · src\/checkout\.ts:\d+ \(new\)/,
    );

    fireEvent.click(within(detail).getByText('formatPrice'));
    expect(within(detail).getAllByRole('heading')[0]!.textContent).toBe('formatPrice');
    const fromRoot = within(detail).getByText('Related changes').nextElementSibling!;
    for (const caller of callers) expect(fromRoot.textContent).toContain(`called by ${caller}`);
  });

  const model = () => buildModel(data);
});

describe('loadReviewData', () => {
  it('reports missing data', () => {
    document.body.innerHTML = '';
    expect(loadReviewData(document)).toEqual({
      ok: false,
      error: 'This page has no changes.json data.',
    });
  });

  it('reports a schema version from another build', () => {
    document.body.innerHTML = dataScripts({
      ...embedded(),
      graph: { ...data.graph, schemaVersion: 99 },
    });
    const result = loadReviewData(document);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/^graph\.json: .*schemaVersion 99.*newer/);
  });

  it('reports documents from different snapshots', () => {
    const snapshotId = 'f'.repeat(64);
    document.body.innerHTML = dataScripts({ ...embedded(), plan: { ...data.plan, snapshotId } });
    const result = loadReviewData(document);
    expect(!result.ok && result.error).toBe(
      `plan.json is for snapshot ${snapshotId}, but changes.json is for ${data.changeSet.snapshotId}.`,
    );
  });

  it('shows the error in place of the app', () => {
    document.body.innerHTML = '';
    render(<App result={loadReviewData(document)} />);
    expect(screen.getByRole('heading').textContent).toBe('This review can’t be shown');
    expect(screen.getByText('This page has no changes.json data.')).toBeTruthy();
  });
});
