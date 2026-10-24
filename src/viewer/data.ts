// Loads the review data embedded in the page (embed.ts) and validates it against the contracts,
// so a stale or hand-edited file shows a clear error instead of failing somewhere in the UI. The
// viewer never fetches anything: everything it shows comes from these elements (spec D7).
import { z } from 'zod';
import type { ChangeSet } from '../schemas/changeset.ts';
import { type ContractName, parseContract, SchemaVersionError } from '../schemas/contracts.ts';
import type { ChangeGraph } from '../schemas/graph.ts';
import type { ReviewPlan } from '../schemas/plan.ts';
import { DATA_ELEMENT_IDS, type DataName } from '../renderer/embed.ts';

export interface ReviewData {
  changeSet: ChangeSet;
  graph: ChangeGraph;
  plan: ReviewPlan;
}

/**
 * Where the data elements are looked up: the page's `document`. Only this much of it, so Node-side
 * tests can check a written review.html with the same code (src/cli/render.test.ts).
 */
export interface DataSource {
  getElementById(id: string): { textContent: string | null } | null;
}

export type LoadResult = { ok: true; data: ReviewData } | { ok: false; error: string };

const DOCUMENTS: Record<DataName, { contract: ContractName; file: string }> = {
  changes: { contract: 'change-set', file: 'changes.json' },
  graph: { contract: 'change-graph', file: 'graph.json' },
  plan: { contract: 'review-plan', file: 'plan.json' },
};

export function loadReviewData(document: DataSource): LoadResult {
  try {
    const changeSet = read(document, 'changes') as ChangeSet;
    const graph = read(document, 'graph') as ChangeGraph;
    const plan = read(document, 'plan') as ReviewPlan;
    for (const [file, snapshotId] of [
      ['graph.json', graph.snapshotId],
      ['plan.json', plan.snapshotId],
    ] as const) {
      if (snapshotId !== changeSet.snapshotId) {
        throw new Error(
          `${file} is for snapshot ${snapshotId}, but changes.json is for ${changeSet.snapshotId}.`,
        );
      }
    }
    return { ok: true, data: { changeSet, graph, plan } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function read(document: DataSource, name: DataName): unknown {
  const { contract, file } = DOCUMENTS[name];
  const text = document.getElementById(DATA_ELEMENT_IDS[name])?.textContent;
  if (text === undefined || text === null) throw new Error(`This page has no ${file} data.`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`The embedded ${file} is not valid JSON: ${(error as Error).message}`, {
      cause: error,
    });
  }
  try {
    return parseContract(contract, json);
  } catch (error) {
    if (error instanceof SchemaVersionError)
      throw new Error(`${file}: ${error.message}.`, { cause: error });
    if (error instanceof z.ZodError) {
      throw new Error(
        `The embedded ${file} does not match its schema:\n${z.prettifyError(error)}`,
        {
          cause: error,
        },
      );
    }
    throw error;
  }
}
