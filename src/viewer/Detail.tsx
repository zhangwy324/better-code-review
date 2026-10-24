// The detail pane: the selected group, node, hunk or canvas edge. A node or hunk shows its real diff
// (Diff.tsx), and a node its related changes, to navigate along edges. A group or node can be
// marked reviewed at once, and each hunk in its diff (#32, spec D5). An edge shows its links'
// direction, provenance and evidence (spec D6). All code shown comes from changes.json (spec
// invariant 5).
import type { FileChange } from '../schemas/changeset.ts';
import type { ChangeNode } from '../schemas/graph.ts';
import type { ReviewGroup } from '../schemas/plan.ts';
import { count } from '../text/index.ts';
import { GroupComments } from './Comments.tsx';
import { Diff } from './Diff.tsx';
import {
  filePath,
  groupHunkIds,
  hunkHeader,
  type Link,
  lineCounts,
  linkLabel,
  linkSentence,
  STYLE_DESCRIPTIONS,
} from './model.ts';
import { progressLabel, ReviewedCheckbox, useProgress } from './Progress.tsx';
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
  if (selection.kind === 'links') {
    return selection.ids.map((id) => {
      const link = model.links.get(id);
      return link === undefined ? null : <LinkDetail key={id} link={link} />;
    });
  }
  return <HunkDetail id={selection.id} />;
}

function GroupDetail({ group }: { group: ReviewGroup }) {
  const model = useModel();
  const hunkIds = groupHunkIds(model, group);
  const p = useProgress(hunkIds);
  return (
    <>
      <h2>{group.title}</h2>
      {group.description !== '' && <p>{group.description}</p>}
      <p>
        <span className="count">
          {count(p.total, 'hunk')} · {progressLabel(p)}
        </span>{' '}
        <ReviewedCheckbox
          hunkIds={hunkIds}
          label={`Mark group ${group.title} reviewed`}
          text="Group reviewed"
        />
      </p>
      <GroupComments key={group.id} groupId={group.id} />
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
        )}{' '}
        <ReviewedCheckbox hunkIds={node.hunkIds} label={`Mark ${node.displayName} reviewed`} />
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
      <RelatedChanges node={node} />
      <Diffs hunkIds={node.hunkIds} />
    </>
  );
}

/** The changes linked to `node`, each a step along an edge (design reference §6.3). */
function RelatedChanges({ node }: { node: ChangeNode }) {
  const model = useModel();
  const { select } = useSelection();
  const links = [...model.links.values()].filter(
    (l) => l.source === node.id || l.target === node.id,
  );
  if (links.length === 0) return null;
  return (
    <>
      <h3>Related changes</h3>
      <ul className="related">
        {links.map((link) => {
          const outgoing = link.source === node.id;
          const other = model.nodes.get(outgoing ? link.target : link.source);
          if (other === undefined) return null;
          return (
            <li key={link.id} className={`link-${link.style}`}>
              {outgoing
                ? `${linkLabel(link)} `
                : link.kind === 'code'
                  ? `${link.edge.relation} `
                  : `${linkLabel(link)} from `}
              <button
                type="button"
                className="link"
                onClick={() => select({ kind: 'node', id: other.id })}
              >
                {other.displayName}
              </button>{' '}
              <button
                type="button"
                className="link evidence"
                title={STYLE_DESCRIPTIONS[link.style]}
                onClick={() => select({ kind: 'links', ids: [link.id] })}
              >
                {link.style}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** One code edge or inferred relationship: direction, provenance and evidence. */
function LinkDetail({ link }: { link: Link }) {
  const model = useModel();
  const ends = [link.source, link.target].flatMap((id) => {
    const node = model.nodes.get(id);
    return node === undefined ? [] : [node];
  });
  return (
    <section className={`link-detail link-${link.style}`}>
      <h2>{linkSentence(model, link)}</h2>
      <p>{STYLE_DESCRIPTIONS[link.style]}</p>
      <NodeLinks ids={ends.map((n) => n.id)} />
      {link.kind === 'code' ? (
        <>
          <p>
            {link.edge.sides === 'both'
              ? 'In the old and new code.'
              : link.edge.sides === 'new'
                ? 'Only in the new code (added).'
                : 'Only in the old code (removed).'}
          </p>
          {link.verdict !== null && (
            <p>
              Agent verdict: <strong>{link.verdict.verdict}</strong>
              {link.verdict.via !== null && ` (${link.verdict.via})`}. {link.verdict.reason}{' '}
              <CitedLine line={link.verdict.citedLine} />
            </p>
          )}
          <h3>Evidence</h3>
          <ul className="evidence-list">
            {link.edge.evidenceIds.map((id) => {
              const record = model.evidence.get(id);
              if (record === undefined) return null;
              const { path, side, range } = record.location;
              return (
                <li key={id}>
                  {record.method} · {record.outcome}
                  {record.detail !== null && ` · ${record.detail}`} ·{' '}
                  <span className="path">
                    {path}:{range.startLine} ({side})
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <>
          <p>{link.relationship.explanation}</p>
          <ul className="evidence-list">
            {link.relationship.citedLines.map((line, i) => (
              <li key={i}>
                <CitedLine line={line} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function CitedLine({ line }: { line: { path: string; side: string; line: number } }) {
  return (
    <span className="path">
      {line.path}:{line.line} ({line.side})
    </span>
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
export function Diffs({ hunkIds }: { hunkIds: readonly string[] }) {
  const model = useModel();
  const { select } = useSelection();
  const files = new Map<FileChange, string[]>();
  for (const id of hunkIds) {
    const file = model.hunks.get(id)?.file;
    if (file !== undefined) files.set(file, [...(files.get(file) ?? []), id]);
  }
  // Keyed by path, so a diff's expanded context and comment form stay with its file.
  return [...files].map(([file, ids]) => (
    <Diff
      key={filePath(file)}
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
