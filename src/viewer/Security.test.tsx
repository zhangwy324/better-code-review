// @vitest-environment jsdom
// The malicious-content fixture (#35, spec invariant 6): repository text (code, file names, a
// Trojan Source line) and plan text an agent could write (titles, descriptions, the summary, a
// verdict's reason, an inferred relationship's explanation) full of HTML and script. Every view
// shows it as text, nothing runs, and each bidirectional control is isolated and marked.
// src/cli/security.test.ts checks the page and the CLI side.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  HOSTILE_HTML,
  hostilePlan,
  HTML_PATH,
  maliciousContent,
  TROJAN_LINE,
} from '../../test/fixtures/malicious-content.ts';
import { buildFixtureRepo } from '../../test/fixtures/repo.ts';
import type { ReviewData } from './data.ts';
import { SHARING_NOTE } from './Outline.tsx';
import { embedded, generateReview, renderEmbedded } from './testing.tsx';

const root = mkdtempSync(join(tmpdir(), 'bcr-security-'));
let data: ReviewData;

beforeAll(() => {
  const { head } = buildFixtureRepo(join(root, 'repo'), maliciousContent);
  data = generateReview(join(root, 'repo'), head, join(root, 'out'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

/**
 * Nothing the data could have made: no script but the three data elements, and no frame, object,
 * image, link or event handler.
 */
function expectInert() {
  const scripts = [...document.querySelectorAll('script')];
  expect(scripts.map((s) => [s.type, s.id])).toEqual([
    ['application/json', 'bcr-changes'],
    ['application/json', 'bcr-graph'],
    ['application/json', 'bcr-plan'],
  ]);
  expect(document.querySelector('iframe, object, embed, img, link, b')).toBeNull();
  for (const element of document.querySelectorAll('*')) {
    const handlers = element.getAttributeNames().filter((name) => /^on/i.test(name));
    expect(handlers, element.outerHTML.slice(0, 80)).toEqual([]);
  }
  expect((globalThis as { pwned?: unknown }).pwned).toBeUndefined();
}

describe('malicious content', () => {
  it('renders repository and plan text as text in every view', () => {
    renderEmbedded(embedded({ ...data, plan: hostilePlan(data.plan, data.graph) }));
    expectInert();
    const outline = screen.getByRole('navigation', { name: 'Review outline' });
    expect(within(outline).getByText(`Summary ${HOSTILE_HTML}`)).toBeTruthy();
    expect(within(outline).getByText(SHARING_NOTE)).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Guided' }));
    expect(screen.getAllByText(`Description ${HOSTILE_HTML}`).length).toBeGreaterThan(0);
    expectInert();

    fireEvent.click(screen.getByRole('tab', { name: 'Files' }));
    const files = screen.getByRole('region', { name: 'Files' });
    expect(within(files).getAllByText(HTML_PATH).length).toBeGreaterThan(0);
    expect(files.textContent).toContain(`const banner = '${HOSTILE_HTML}';`);
    expectInert();

    // The verdict's reason and the inferred relationship's explanation, in the detail pane.
    const detail = screen.getByRole('region', { name: 'Selected change' });
    for (const [name, text] of [
      ['page', `Reason ${HOSTILE_HTML}`],
      ['banner', `Explanation ${HOSTILE_HTML}`],
    ]) {
      fireEvent.click(within(outline).getByText(name!));
      const related = within(detail).getByText('Related changes').nextElementSibling!;
      const link = [...related.querySelectorAll('button')].at(-1)!;
      fireEvent.click(link);
      expect(detail.textContent).toContain(text);
      expectInert();
    }
  });

  it('isolates and marks each bidirectional control of a Trojan Source line', () => {
    renderEmbedded(embedded(data));
    fireEvent.click(screen.getByRole('tab', { name: 'Files' }));
    const files = screen.getByRole('region', { name: 'Files' });
    const row = [...files.querySelectorAll('tr')].find((tr) =>
      tr.querySelector('.code')?.textContent.includes('admins only'),
    )!;
    // The text is the line as committed, byte for byte.
    expect(row.querySelector('.code')!.textContent).toBe(TROJAN_LINE);
    const marks = [...row.querySelectorAll('.bidi')];
    expect(marks.map((m) => [m.getAttribute('data-code'), m.textContent])).toEqual([
      ['U+202E', '‮'],
      ['U+2066', '⁦'],
      ['U+2069', '⁩'],
      ['U+2066', '⁦'],
    ]);
  });
});
