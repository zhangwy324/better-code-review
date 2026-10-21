// The detail pane: the selected group, node or hunk. A node or hunk shows its real diff (Diff.tsx).
// All code shown comes from changes.json (spec invariant 5).
import type { FileChange } from '../schemas/changeset.ts';
import type { ChangeNode } from '../schemas/graph.ts';
import type { ReviewGroup } from '../schemas/plan.ts';
import { Diff } from './Diff.tsx';
import { filePath, hunkHeader, lineCounts } from './model.ts';
import { type Selection, useModel, useSelection } from './state.tsx';

export function Detail() {
  const { selection } = useSelection();
  return (
    <section className="pane detail" aria-label="Selected change">
      <DetailBody selection={selection} />
    </section>
  );
}

function DetailBody({ selection }: { selection: Selection }) {
  const model = useModel();
  if (selection === null) return <p className="hint">Select a group, change or hunk.</p>;
  if (selection.kind === 'group') {
    const group = model.groups.get(selection.id);
    return group === undefined ? null : <GroupDetail group={group} />;
  }
  if (selection.kind === 'node') {
    const node = model.nodes.get(selection.id);
    return node === undefined ? null : <NodeDetail node={node} />;
  }
  return <HunkDetail id={selection.id} />;
}

function GroupDetail({ group }: { group: ReviewGroup }) {
  return (
    <>
      <h2>{group.title}</h2>
      {group.description !== '' && <p>{group.description}</p>}
      <NodeLinks ids={group.nodeIds} />
    </>
  );
}

function NodeDetail({ node }: { node: ChangeNode }) {
  const model = useModel();
  const { select } = useSelection();
  const home = model.homeGroup.get(node.id);
  const range = node.newRange ?? node.oldRange;
  return (
    <>
      <h2>{node.displayName}</h2>
      <p className="path">
        {node.path}
        {range !== null && `:${range.startLine}-${range.endLine}`}
        {node.oldPath !== null && node.oldPath !== node.path && ` (was ${node.oldPath})`}
      </p>
      <p>
        {node.entityKind ?? node.kind}
        {home !== undefined && (
          <>
            {' in '}
            <button
              type="button"
              className="link"
              onClick={() => select({ kind: 'group', id: home.id })}
            >
              {home.title}
            </button>
          </>
        )}
      </p>
      <ul className="hunks">
        {node.hunkIds.map((id) => {
          const entry = model.hunks.get(id);
          if (entry === undefined) return null;
          const { added, removed } = lineCounts(entry.hunk);
          return (
            <li key={id}>
              <button type="button" className="link" onClick={() => select({ kind: 'hunk', id })}>
                <code>{hunkHeader(entry.hunk)}</code> +{added} −{removed}
              </button>
            </li>
          );
        })}
      </ul>
      <Diffs hunkIds={node.hunkIds} />
    </>
  );
}

function HunkDetail({ id }: { id: string }) {
  const model = useModel();
  const entry = model.hunks.get(id);
  if (entry === undefined) return null;
  return (
    <>
      <h2>
        <code>{hunkHeader(entry.hunk)}</code>
      </h2>
      <p className="path">{filePath(entry.file)}</p>
      <NodeLinks ids={(model.hunkNodes.get(id) ?? []).map((n) => n.id)} />
      <Diffs hunkIds={[id]} />
    </>
  );
}

/** One diff per file the hunks are in, in the order the files first appear. */
function Diffs({ hunkIds }: { hunkIds: readonly string[] }) {
  const model = useModel();
  const { select } = useSelection();
  const files = new Map<FileChange, string[]>();
  for (const id of hunkIds) {
    const file = model.hunks.get(id)?.file;
    if (file !== undefined) files.set(file, [...(files.get(file) ?? []), id]);
  }
  return [...files].map(([file, ids], i) => (
    <Diff
      key={i}
      file={file}
      hunkIds={ids}
      language={model.languages.get(filePath(file)) ?? null}
      onSelectHunk={hunkIds.length > 1 ? (id) => select({ kind: 'hunk', id }) : undefined}
    />
  ));
}

function NodeLinks({ ids }: { ids: string[] }) {
  const model = useModel();
  const { select } = useSelection();
  return (
    <ul className="node-links">
      {ids.flatMap((id) => {
        const node = model.nodes.get(id);
        if (node === undefined) return [];
        return [
          <li key={id}>
            <button type="button" className="link" onClick={() => select({ kind: 'node', id })}>
              {node.displayName}
            </button>{' '}
            <span className="path">{node.path}</span>
          </li>,
        ];
      })}
    </ul>
  );
}
