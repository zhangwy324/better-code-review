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
import { hunkHeader } from './model.ts';

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
    expect(within(canvas).getByRole('heading').textContent).toBe(group.title);
    expect(within(detail).getByRole('heading').textContent).toBe(group.title);

    fireEvent.click(within(canvas).getByText(node.displayName));
    expect(within(detail).getByRole('heading').textContent).toBe(node.displayName);
    const current = outline.querySelectorAll('[aria-current]');
    expect([...current].map((e) => e.textContent)).toEqual([node.displayName]);

    const hunk = data.changeSet.files
      .flatMap((f) => f.hunks)
      .find((h) => h.id === node.hunkIds[0])!;
    fireEvent.click(within(detail).getByText(hunkHeader(hunk)));
    expect(within(detail).getByText((_, e) => e?.tagName === 'PRE').textContent).toBe(hunk.patch);
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
