// @vitest-environment jsdom
// The app shell on a real fixture's data (#27 acceptance: loads fixture JSON and shows the header
// and outline with no network access), shared selection, and inert rendering of untrusted text.
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReviewData } from './data.ts';
import { hunkHeader } from './model.ts';
import { embedded, renderEmbedded, signatureReview } from './testing.tsx';

let data: ReviewData;
let dispose: () => void;

beforeAll(() => ({ data, dispose } = signatureReview()));
afterAll(() => dispose());
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('App', () => {
  it('shows the header and outline from the embedded data with no network access', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const open = vi.spyOn(XMLHttpRequest.prototype, 'open');
    renderEmbedded(embedded(data));

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
    renderEmbedded(embedded(data));
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
    fireEvent.click(
      within(detail.querySelector<HTMLElement>('ul.hunks')!).getByText(hunkHeader(hunk)),
    );
    const shown = detail.querySelectorAll(`tbody[data-hunk-id="${hunk.id}"]`);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.querySelector('.hunk-header')!.textContent).toBe(hunk.patch.split('\n')[0]);
  });

  it("shows each hunk's @@ line the same in a node's hunk list and its diff (#108)", () => {
    renderEmbedded(embedded(data));
    const outline = screen.getByRole('navigation', { name: 'Review outline' });
    const detail = screen.getByRole('region', { name: 'Selected change' });
    const seen: string[] = [];
    for (const node of data.graph.nodes) {
      fireEvent.click(within(outline).getAllByText(node.displayName)[0]!);
      expect(within(detail).getAllByRole('heading')[0]!.textContent).toBe(node.displayName);
      const listed = [...detail.querySelectorAll('ul.hunks code')].map((c) => c.textContent);
      const diffed = [...detail.querySelectorAll('.hunk-header td:nth-child(2)')].map(
        (td) => td.textContent,
      );
      expect(listed).toEqual(diffed);
      seen.push(...listed);
    }
    // Git leaves out a one-line range's ",1", and adds the enclosing function after the second @@.
    expect(seen).toContain('@@ -1 +1 @@');
    expect(seen.some((h) => /^@@ [^@]+ @@ \S/.test(h))).toBe(true);
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
