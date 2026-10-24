// @vitest-environment jsdom
// #32 acceptance: review progress agrees across the graph, guided and file views (and the outline,
// detail pane and header), a group is reviewed when all its home hunks are (spec D5), every
// homeless change is in Ungrouped / requires review (D1), coverage is `N/N hunks mapped` and
// never a claim that all effects were found (§13.2), and missing analyzers are shown (§10.8, D11).
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseContract } from '../schemas/contracts.ts';
import type { ReviewFeedback } from '../schemas/feedback.ts';
import { homeEveryNode } from '../planner/validate.ts';
import { UNGROUPED_GROUP_ID, UNGROUPED_TITLE } from '../schemas/plan.ts';
import type { ReviewData } from './data.ts';
import { buildModel, groupHunkIds, hunkHeader, TIER_DESCRIPTIONS } from './model.ts';
import { embedded, renderEmbedded, signatureReview } from './testing.tsx';

let data: ReviewData;
let dispose: () => void;

beforeAll(() => ({ data, dispose } = signatureReview()));
afterAll(() => dispose());
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  localStorage.clear();
  vi.restoreAllMocks();
});

const show = (name: string) => fireEvent.click(screen.getByRole('tab', { name }));
const pane = (name: string) => screen.getByRole('region', { name });
const outline = () => screen.getByRole('navigation', { name: 'Review outline' });
const header = () => screen.getByRole('banner');
const allHunks = () => data.changeSet.files.flatMap((f) => f.hunks);

/** The accessible name of a hunk's checkbox in a diff. */
function hunkLabel(id: string): string {
  const file = data.changeSet.files.find((f) => f.hunks.some((h) => h.id === id))!;
  const hunk = file.hunks.find((h) => h.id === id)!;
  return `Mark ${file.newPath ?? file.oldPath} ${hunkHeader(hunk)} reviewed`;
}

const checkbox = (container: HTMLElement, name: string) =>
  within(container).getByRole<HTMLInputElement>('checkbox', { name });

/** The group's outline entry. */
const outlineGroup = (title: string) =>
  within(outline()).getByText(title).closest('li')!.querySelector('.group-title')!;

/** What every view says about `hunkIds`' review status: one entry per view that shows them. */
function hunkStates(hunkIds: readonly string[]) {
  const states: Record<string, boolean[]> = {};
  for (const [tab, region] of [
    ['Guided', 'Guided review'],
    ['Files', 'Files'],
  ]) {
    show(tab!);
    states[tab!] = hunkIds.map((id) => checkbox(pane(region!), hunkLabel(id)).checked);
  }
  show('Graph');
  return states;
}

/** Clicks the export button and returns the downloaded file, parsed as the contract. */
async function exportFeedback(): Promise<ReviewFeedback> {
  let blob: Blob | undefined;
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => ((blob = b as Blob), 'blob:x'));
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  fireEvent.click(screen.getByRole('button', { name: 'Export review-feedback.json' }));
  return parseContract('review-feedback', JSON.parse(await blob!.text()));
}

describe('review progress', () => {
  it('agrees across the graph, guided and file views, the outline, detail pane and header', () => {
    renderEmbedded(embedded(data));
    const model = buildModel(data);
    const group = data.plan.groups.find((g) => g.nodeIds.length > 1)!;
    const groupHunks = groupHunkIds(model, group);
    const node = data.graph.nodes.find((n) => n.id === group.nodeIds[0])!;
    const total = allHunks().length;
    const canvasGroup = () =>
      within(pane('Canvas')).getByTitle(group.title).closest('.canvas-group')!;
    const expectEverywhere = (reviewed: number) => {
      const label = `${reviewed}/${groupHunks.length} reviewed`;
      expect(outlineGroup(group.title).textContent).toContain(label);
      expect(canvasGroup().textContent).toContain(
        `${reviewed}/${groupHunks.length} hunks reviewed`,
      );
      show('Guided');
      const guided = pane('Guided review').querySelector(`[data-group-id="${group.id}"] > h3`)!;
      expect(guided.textContent).toContain(label);
      show('Graph');
      expect(header().textContent).toContain(`${reviewed}/${total} hunks reviewed`);
    };
    expectEverywhere(0);

    // One hunk, marked in the file view.
    show('Files');
    fireEvent.click(checkbox(pane('Files'), hunkLabel(node.hunkIds[0]!)));
    expect(hunkStates(node.hunkIds.slice(0, 1))).toEqual({ Guided: [true], Files: [true] });
    expectEverywhere(1);

    // The whole group, marked in the guided review.
    show('Guided');
    fireEvent.click(checkbox(pane('Guided review'), `Mark group ${group.title} reviewed`));
    const all = groupHunks.map(() => true);
    expect(hunkStates(groupHunks)).toEqual({ Guided: all, Files: all });
    expectEverywhere(groupHunks.length);
    expect(outlineGroup(group.title).textContent).toContain('✓');
    expect(canvasGroup().querySelector('.count.done')).not.toBeNull();

    // One change, unmarked in the detail pane after selecting it on the canvas.
    fireEvent.click(canvasGroup().querySelector('.toggle')!);
    fireEvent.click(within(pane('Canvas')).getAllByText(node.displayName)[0]!);
    const detail = pane('Selected change');
    fireEvent.click(checkbox(detail, `Mark ${node.displayName} reviewed`));
    expect(checkbox(detail, `Mark ${node.displayName} reviewed`).checked).toBe(false);
    const left = groupHunks.length - node.hunkIds.length;
    expect(hunkStates(node.hunkIds)).toEqual({
      Guided: node.hunkIds.map(() => false),
      Files: node.hunkIds.map(() => false),
    });
    expect(outlineGroup(group.title).textContent).toContain(`${left}/${groupHunks.length}`);
    show('Guided');
    const groupBox = checkbox(pane('Guided review'), `Mark group ${group.title} reviewed`);
    expect([groupBox.checked, groupBox.indeterminate]).toEqual([false, true]);
    show('Graph');
    expect(header().textContent).toContain(`${left}/${total} hunks reviewed`);
  });

  it('counts a group’s home hunks only, not the changes it references', () => {
    const [a, b] = data.plan.groups.filter((g) => g.nodeIds.length > 0);
    const referenced = b!.nodeIds[0]!;
    const plan = {
      ...data.plan,
      groups: data.plan.groups.map((g) =>
        g.id === a!.id ? { ...g, referenceNodeIds: [referenced] } : g,
      ),
    };
    renderEmbedded(embedded({ ...data, plan }));
    fireEvent.click(within(outline()).getByText(a!.title));
    fireEvent.click(checkbox(pane('Selected change'), `Mark group ${a!.title} reviewed`));

    const model = buildModel({ ...data, plan });
    const homeHunks = groupHunkIds(model, a!).length;
    expect(outlineGroup(a!.title).textContent).toContain(`✓ ${homeHunks}/${homeHunks} reviewed`);
    expect(outlineGroup(b!.title).textContent).toContain('0/');
    const node = data.graph.nodes.find((n) => n.id === referenced)!;
    show('Files');
    expect(checkbox(pane('Files'), hunkLabel(node.hunkIds[0]!)).checked).toBe(false);
  });

  it('exports the reviewed hunks, and keeps them in the browser until then', async () => {
    renderEmbedded(embedded(data));
    const exportButton = () =>
      screen.getByRole<HTMLButtonElement>('button', { name: 'Export review-feedback.json' });
    expect(exportButton().disabled).toBe(true);
    const node = data.graph.nodes.find((n) => n.hunkIds.length > 0)!;
    fireEvent.click(within(outline()).getAllByText(node.displayName)[0]!);
    fireEvent.click(checkbox(pane('Selected change'), `Mark ${node.displayName} reviewed`));
    expect(exportButton().disabled).toBe(false);
    expect(header().textContent).toContain('not exported');

    // A reload finds them again.
    cleanup();
    renderEmbedded(embedded(data));
    expect(header().textContent).toContain(`${node.hunkIds.length}/`);
    expect(header().textContent).toContain('not exported');

    const order = allHunks().map((h) => h.id);
    const feedback = await exportFeedback();
    expect(feedback.reviewedHunkIds).toEqual(order.filter((id) => node.hunkIds.includes(id)));
    expect(header().textContent).not.toContain('not exported');

    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Copy feedback for agent' }));
        await Promise.resolve();
      });
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
    expect(writeText.mock.calls[0]![0]).toContain(
      `The reviewer marked ${node.hunkIds.length} of ${order.length} hunks reviewed`,
    );
  });
});

describe('Ungrouped / requires review', () => {
  it('holds every change the plan gave no home, in every view', () => {
    const dropped = data.plan.groups.find((g) => g.nodeIds.length > 1)!;
    const plan = {
      ...data.plan,
      groups: data.plan.groups.filter((g) => g.id !== dropped.id),
      groupOrder: data.plan.groupOrder.filter((id) => id !== dropped.id),
    };
    renderEmbedded(embedded({ ...data, plan }));

    const entry = within(outline()).getByText(UNGROUPED_TITLE).closest('li')!;
    expect(entry.classList).toContain('ungrouped');
    for (const id of dropped.nodeIds) {
      const node = data.graph.nodes.find((n) => n.id === id)!;
      expect(within(entry).getAllByText(node.displayName).length).toBeGreaterThan(0);
    }
    const canvasGroup = within(pane('Canvas')).getByTitle(UNGROUPED_TITLE).closest('.canvas-group');
    expect(canvasGroup!.classList).toContain('ungrouped');
    show('Guided');
    const guided = pane('Guided review').querySelector(`[data-group-id="${UNGROUPED_GROUP_ID}"]`)!;
    expect(guided.classList).toContain('ungrouped');
    for (const id of dropped.nodeIds) {
      expect(guided.querySelector(`[data-node-id="${id}"] tbody[data-hunk-id]`)).not.toBeNull();
    }
  });

  it('shows one Ungrouped group when `render` already made it (#34)', () => {
    const dropped = data.plan.groups.find((g) => g.nodeIds.length > 1)!;
    const agentPlan = {
      ...data.plan,
      groups: data.plan.groups.filter((g) => g.id !== dropped.id),
      groupOrder: data.plan.groupOrder.filter((id) => id !== dropped.id),
    };
    // `render` embeds the validated plan, which already has Ungrouped (validatePlan's last step).
    const { plan } = homeEveryNode(agentPlan, data.graph);
    expect(plan.groupOrder.filter((id) => id === UNGROUPED_GROUP_ID)).toHaveLength(1);
    renderEmbedded(embedded({ ...data, plan }));

    const model = buildModel({ ...data, plan });
    expect(model.plan.groups.filter((g) => g.id === UNGROUPED_GROUP_ID)).toHaveLength(1);
    expect(model.plan.groupOrder.filter((id) => id === UNGROUPED_GROUP_ID)).toHaveLength(1);
    // Each homeless node once, no duplicates.
    expect(model.groups.get(UNGROUPED_GROUP_ID)?.nodeIds.toSorted()).toEqual(
      dropped.nodeIds.toSorted(),
    );
    expect(within(outline()).getAllByText(UNGROUPED_TITLE)).toHaveLength(1);
    expect(within(pane('Canvas')).getAllByTitle(UNGROUPED_TITLE)).toHaveLength(1);
    show('Guided');
    expect(
      pane('Guided review').querySelectorAll(`[data-group-id="${UNGROUPED_GROUP_ID}"]`),
    ).toHaveLength(1);
  });

  it('holds every change when the plan has no groups', () => {
    const plan = { ...data.plan, groups: [], groupOrder: [] };
    renderEmbedded(embedded({ ...data, plan }));
    show('Guided');
    const guided = pane('Guided review');
    const shown = [...guided.querySelectorAll('tbody[data-hunk-id]')].map((e) =>
      e.getAttribute('data-hunk-id'),
    );
    expect(new Set(shown)).toEqual(new Set(allHunks().map((h) => h.id)));
    expect(within(guided).getByText(UNGROUPED_TITLE)).toBeTruthy();
  });

  it('is not added when every change has a home', () => {
    renderEmbedded(embedded(data));
    expect(within(outline()).queryByText(UNGROUPED_TITLE)).toBeNull();
  });
});

describe('coverage and analysis', () => {
  it('says how many hunks are mapped, and never that all effects were found', () => {
    renderEmbedded(embedded(data));
    const total = allHunks().length;
    const badge = within(header()).getByText(`${total}/${total} hunks mapped`);
    expect(badge.classList).not.toContain('unmapped');
    expect(badge.title).toContain('not the effects of the change');
    expect(header().textContent).not.toMatch(/all effects|complete/i);
  });

  it('flags hunks that are on no change', () => {
    const graph = {
      ...data.graph,
      nodes: data.graph.nodes.map((n, i) => (i === 0 ? { ...n, hunkIds: [] } : n)),
    };
    renderEmbedded(embedded({ ...data, graph }));
    const total = allHunks().length;
    const lost = data.graph.nodes[0]!.hunkIds.length;
    const badge = within(header()).getByText(`${total - lost}/${total} hunks mapped`);
    expect(badge.classList).toContain('unmapped');
  });

  it('shows each file’s capability tier and each language’s missing server', () => {
    renderEmbedded(embedded(data));
    const analysis = within(outline()).getByRole('region', { name: 'Analysis' });
    const tiers = data.graph.files.map((f) => f.capabilityTier);
    const structural = tiers.filter((t) => t === 'structural').length;
    expect(analysis.textContent).toContain(`${structural} structural files`);
    expect(analysis.textContent).toContain('1 git-only file');
    for (const l of data.graph.languages) {
      expect(analysis.textContent).toContain(`${l.language}: language servers turned off`);
      expect(analysis.textContent).toContain(l.guidance!);
    }
    expect(analysis.querySelectorAll('li.missing')).toHaveLength(data.graph.languages.length);

    show('Files');
    const gitOnly = data.graph.files.find((f) => f.capabilityTier === 'git-only')!;
    const file = pane('Files').querySelector(`article[data-path="${gitOnly.path}"] h3`)!;
    const tier = within(file as HTMLElement).getByText('git-only');
    expect(tier.title).toBe(TIER_DESCRIPTIONS['git-only']);
  });
});
