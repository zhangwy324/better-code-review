// A one-line description of what a ChangeSet compares, for summary.txt and the planner input.
import type { ChangeSet } from '../schemas/changeset.ts';

export function describeTarget(changeSet: ChangeSet): string {
  const short = (id: string | null) => (id === null ? 'the empty tree' : id.slice(0, 7));
  const range = `${short(changeSet.baseRevision)}..${short(changeSet.headRevision)}`;
  const target = changeSet.target;
  switch (target.kind) {
    case 'pr':
      return `pull request #${target.number} (${range})`;
    case 'commit':
      return `commit ${short(changeSet.headRevision)} (against ${short(changeSet.baseRevision)})`;
    case 'range':
      return `range ${target.base}${target.mode === 'direct' ? '..' : '...'}${target.head} (${range})`;
    case 'local':
      return `local changes against ${changeSet.baseRevision === null ? 'an unborn branch' : short(changeSet.baseRevision)}`;
  }
}
