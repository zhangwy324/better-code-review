// @vitest-environment jsdom
// Loading the embedded documents, and the error shown in place of the app when they can't be used.
import { cleanup, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { dataScripts } from '../renderer/embed.ts';
import { App } from './App.tsx';
import { loadReviewData, type ReviewData } from './data.ts';
import { embedded, signatureReview } from './testing.tsx';

let data: ReviewData;
let dispose: () => void;

beforeAll(() => ({ data, dispose } = signatureReview()));
afterAll(() => dispose());
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
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
      ...embedded(data),
      graph: { ...data.graph, schemaVersion: 99 },
    });
    const result = loadReviewData(document);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/^graph\.json: .*schemaVersion 99.*newer/);
  });

  it('reports documents from different snapshots', () => {
    const snapshotId = 'f'.repeat(64);
    document.body.innerHTML = dataScripts({
      ...embedded(data),
      plan: { ...data.plan, snapshotId },
    });
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
