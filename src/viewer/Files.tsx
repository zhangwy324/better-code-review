// The file view (design reference §6.1, §9.8; spec D3): the familiar file-by-file diff, for
// fallback, auditability and completeness. It shows every file in changes.json with all its hunks,
// straight from the change set, so every hunk is reachable here whatever the plan or graph say.
// Selecting a change or hunk in any pane scrolls the view to its first hunk.
import { useRef } from 'react';
import type { FileChange } from '../schemas/changeset.ts';
import { count, list } from '../text/index.ts';
import { Diff } from './Diff.tsx';
import { filePath, lineCounts } from './model.ts';
import { useScrollToSelection } from './scroll.ts';
import { useModel, useSelection } from './state.tsx';

/** Why a file has no hunks, when it has none (FileChange `hunks`). */
const NO_HUNKS: Partial<Record<FileChange['status'], string>> = {
  renamed: 'Renamed with no content changes.',
  copied: 'Copied with no content changes.',
};

export function Files() {
  const model = useModel();
  const { files, excludedUntrackedPaths } = model.changeSet;
  const pane = useRef<HTMLElement>(null);
  useScrollToSelection(pane, (selection) => {
    const hunkId =
      selection.kind === 'hunk'
        ? selection.id
        : selection.kind === 'node'
          ? model.nodes.get(selection.id)?.hunkIds[0]
          : undefined;
    return hunkId === undefined ? null : `[data-hunk-id="${hunkId}"]`;
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
  let added = 0;
  let removed = 0;
  for (const hunk of file.hunks) {
    const counts = lineCounts(hunk);
    added += counts.added;
    removed += counts.removed;
  }
  const modes =
    file.oldMode !== null && file.newMode !== null && file.oldMode !== file.newMode
      ? ` · mode ${file.oldMode} → ${file.newMode}`
      : '';
  return (
    <article className="file" data-path={path}>
      <h3>
        <span className="path">
          {file.oldPath !== null && file.oldPath !== path && `${file.oldPath} → `}
          {path}
        </span>{' '}
        <span className="count">
          {file.status}
          {modes} · <span className="plus">+{added}</span> <span className="minus">−{removed}</span>
        </span>
      </h3>
      {file.hunks.length === 0 && file.contentOmitted === null && (
        <p className="note">{NO_HUNKS[file.status] ?? 'No content changes.'}</p>
      )}
      <Diff
        file={file}
        language={model.languages.get(path) ?? null}
        onSelectHunk={(id) => select({ kind: 'hunk', id })}
      />
    </article>
  );
}
