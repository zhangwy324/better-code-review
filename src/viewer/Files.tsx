// The file view (design reference §6.1, §9.8; spec D3): the familiar file-by-file diff, for
// fallback, auditability and completeness. It shows every file in changes.json with all its hunks,
// straight from the change set, so every hunk is reachable here whatever the plan or graph say.
// Selecting a change or hunk in any pane scrolls the view to its first hunk, or to the file of a
// change with no hunks. Each file says which capability tier it got (design reference §10.8),
// whether it parsed only partially (#93), and how many of its hunks are reviewed (#32); a file
// change with no hunks (a binary file, a mode change, a pure rename) has its own checkbox (#127).
import { useRef } from 'react';
import type { FileChange } from '../schemas/changeset.ts';
import { count, list } from '../text/index.ts';
import { Diff } from './Diff.tsx';
import {
  filePath,
  lineCounts,
  PARTIAL_PARSE_DESCRIPTION,
  reviewItemIds,
  TIER_DESCRIPTIONS,
} from './model.ts';
import { progressLabel, ReviewedCheckbox, useProgress } from './Progress.tsx';
import { useScrollToSelection } from './scroll.ts';
import { useModel, useSelection } from './state.tsx';

export function Files() {
  const model = useModel();
  const { files, excludedUntrackedPaths } = model.changeSet;
  const pane = useRef<HTMLElement>(null);
  useScrollToSelection(pane, (selection) => {
    if (selection.kind === 'hunk') return `[data-hunk-id="${selection.id}"]`;
    if (selection.kind !== 'node') return null;
    const node = model.nodes.get(selection.id);
    if (node === undefined) return null;
    const hunkId = node.hunkIds[0];
    // A change with no hunks scrolls to its file, which carries the node's ID (hex, safe here).
    return hunkId === undefined ? `[data-node-id="${node.id}"]` : `[data-hunk-id="${hunkId}"]`;
  });
  const hunks = files.reduce((n, f) => n + f.hunks.length, 0);
  return (
    <section ref={pane} className="pane files" aria-label="Files">
      <h2>Files</h2>
      <p className="summary">
        {count(files.length, 'file')} · {count(hunks, 'hunk')}
      </p>
      {excludedUntrackedPaths.length > 0 && (
        <p className="note">
          Not shown: {count(excludedUntrackedPaths.length, 'untracked file')} (
          {list(excludedUntrackedPaths)}).
        </p>
      )}
      {files.map((file, i) => (
        <FileDiff key={i} file={file} />
      ))}
    </section>
  );
}

function FileDiff({ file }: { file: FileChange }) {
  const model = useModel();
  const { select } = useSelection();
  const path = filePath(file);
  const { added, removed } = lineCounts(file.hunks);
  const modes =
    file.oldMode !== null && file.newMode !== null && file.oldMode !== file.newMode
      ? ` · mode ${file.oldMode} → ${file.newMode}`
      : '';
  const tier = model.tiers.get(path);
  const itemIds = reviewItemIds(file);
  const p = useProgress(itemIds);
  const hunkless = file.hunks.length === 0;
  const node = hunkless
    ? model.graph.nodes.find((n) => n.kind === 'file' && n.path === path)
    : undefined;
  return (
    <article className="file" data-path={path} data-node-id={node?.id}>
      <h3>
        <span className="path">
          {file.oldPath !== null && file.oldPath !== path && `${file.oldPath} → `}
          {path}
        </span>{' '}
        <span className="count">
          {file.status}
          {modes} · <span className="plus">+{added}</span> <span className="minus">−{removed}</span>
          {tier !== undefined && (
            <>
              {' · '}
              <span className={`tier tier-${tier}`} title={TIER_DESCRIPTIONS[tier]}>
                {tier}
              </span>
            </>
          )}
          {model.partialParses.has(path) && (
            <>
              {' · '}
              <span className="tier" title={PARTIAL_PARSE_DESCRIPTION}>
                parsed partially
              </span>
            </>
          )}
          {!hunkless && ` · ${progressLabel(p)}`}
        </span>
        {hunkless && (
          <>
            {' '}
            <ReviewedCheckbox itemIds={itemIds} label={`Mark ${path} reviewed`} />
          </>
        )}
      </h3>
      <Diff
        file={file}
        language={model.languages.get(path) ?? null}
        onSelectHunk={(id) => select({ kind: 'hunk', id })}
      />
    </article>
  );
}
