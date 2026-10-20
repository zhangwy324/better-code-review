// The signature fixture (test/fixtures/signature.ts) under its old names, and helpers to run the
// semantic analyzer on a two-commit repository.
import { base, head } from '../../../test/fixtures/signature.ts';
import { extractChangeSet } from '../../git/extract.ts';
import { TestRepo } from '../../git/test-repo.test-helper.ts';
import type { ChangeSet } from '../../schemas/changeset.ts';
import type { SemanticEvidence } from '../../schemas/semantic.ts';
import type { StructuralChangeSet } from '../../schemas/structural.ts';
import { analyzeStructure } from '../structural/analyze.ts';
import { analyzeSemantics, type SemanticOptions } from './analyze.ts';
import { gitSnapshotFiles } from './snapshot-files.ts';

export type Files = Record<string, string | null>;

export const SIGNATURE_BASE = base;
export const SIGNATURE_HEAD = head;

export interface Analysed {
  repo: TestRepo;
  changes: ChangeSet;
  structure: StructuralChangeSet;
  evidence: SemanticEvidence;
}

/**
 * Commits `base`, then `head` on top, and runs the extractor and both analyzers. `options` may
 * be a function of the repository, whose working tree then holds `head` (for a language server),
 * and of the change set.
 */
export async function analyse(
  base: Files,
  head: Files,
  options:
    | Omit<SemanticOptions, 'files'>
    | ((repo: TestRepo, changes: ChangeSet) => Promise<Omit<SemanticOptions, 'files'>>) = {},
): Promise<Analysed> {
  const repo = new TestRepo();
  const commit = repo.commit([repo.commit([], base)], head);
  const changes = await extractChangeSet(repo.path, { kind: 'commit', commit });
  const structure = await analyzeStructure(changes);
  let semanticOptions: Omit<SemanticOptions, 'files'>;
  if (typeof options === 'function') {
    // `commit()` leaves `head` in the index; write it out as the working tree.
    repo.git('checkout-index', '--all', '--force');
    semanticOptions = await options(repo, changes);
  } else {
    semanticOptions = options;
  }
  const evidence = await analyzeSemantics(changes, structure, {
    ...semanticOptions,
    files: gitSnapshotFiles(repo.path, changes),
  });
  return { repo, changes, structure, evidence };
}

/**
 * One line per hit: `side relation source -> target @path:line methods`, where methods lists
 * each record's method and outcome, e.g. `text-search:candidate import-resolution:confirmed`.
 */
export function summary({
  structure,
  evidence,
}: Pick<Analysed, 'structure' | 'evidence'>): string[] {
  const name = (id: string) => {
    const e = structure.entities.find((x) => x.id === id)!;
    return e.name === null
      ? `<module ${e.path}>`
      : e.container
        ? `${e.container}.${e.name}`
        : e.name;
  };
  const byHit = new Map<string, string[]>();
  for (const r of evidence.records) {
    const key = `${r.location.side} ${r.relation} ${name(r.sourceEntityId)} -> ${name(r.targetEntityId)} @${r.location.path}:${r.location.range.startLine}`;
    byHit.set(key, [...(byHit.get(key) ?? []), `${r.method}:${r.outcome}`]);
  }
  return [...byHit].map(([key, methods]) => `${key} ${methods.join(' ')}`);
}
