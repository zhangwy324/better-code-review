// `better-code-review show` (#22): context the planner fetches on demand, beyond planner-input.md.
// Everything comes from the snapshot: changed files from changes.json, unchanged ones from Git at
// the snapshot's revision (gitSnapshotFiles), never from the working tree as it is now. Sensitive
// files are refused and secrets redacted, as in the planner input (secrets.ts).
import type { SnapshotFiles } from '../analysis/semantic/snapshot-files.ts';
import type { ChangeSet } from '../schemas/changeset.ts';
import type { Side } from '../schemas/common.ts';
import type { ChangeGraph } from '../schemas/graph.ts';
import { quotePath } from '../text/index.ts';
import { edgeLine, nodeLine } from './input.ts';
import { redactSecrets, sensitiveFile } from './secrets.ts';

/** Lines printed for one request; a longer file or hunk needs `--lines`. */
export const MAX_SHOW_LINES = 400;
/** Lines around each evidence site of an edge. */
const SITE_CONTEXT = 2;

export type ShowQuery =
  { id: string } | { file: string; side: Side; lines: { start: number; end: number } | null };

/** A request that cannot be answered, with a message the agent can act on. */
export class ShowError extends Error {}

export async function show(
  changeSet: ChangeSet,
  graph: ChangeGraph,
  files: SnapshotFiles,
  query: ShowQuery,
): Promise<string> {
  if ('file' in query) return showFile(files, query.file, query.side, query.lines);
  const { id } = query;
  if (id.startsWith('h_')) return showHunk(changeSet, graph, id);
  if (id.startsWith('n_')) return showNode(graph, files, id);
  if (id.startsWith('e_')) return showEdge(graph, files, id);
  throw new ShowError(`${id} is not a hunk (h_…), node (n_…) or edge (e_…) ID`);
}

function showHunk(changeSet: ChangeSet, graph: ChangeGraph, id: string): string {
  for (const file of changeSet.files) {
    const hunk = file.hunks.find((h) => h.id === id);
    if (hunk === undefined) continue;
    const path = quotePath((file.newPath ?? file.oldPath)!);
    const nodes = graph.nodes
      .filter((n) => n.hunkIds.includes(id))
      .map((n) => quotePath(n.displayName));
    const header = `# ${id} in ${path}${nodes.length > 0 ? ` (${nodes.join(', ')})` : ''}`;
    // Asked for explicitly, so only sensitive files are refused; MAX_SHOW_LINES caps the rest.
    const sensitive = [file.newPath, file.oldPath].map((p) => p && sensitiveFile(p)).find(Boolean);
    if (sensitive) return `${header}\n\nNot shown: withheld: ${sensitive}.\n`;
    const lines = hunk.patch.replace(/\n$/, '').split('\n');
    let text = redactSecrets(lines.slice(0, MAX_SHOW_LINES + 1).join('\n'), 1).text;
    if (lines.length > MAX_SHOW_LINES + 1) {
      text += `\n… ${lines.length - 1 - MAX_SHOW_LINES} more lines; read the file with --file ${path} --lines`;
    }
    return `${header}\n\n${text}\n`;
  }
  throw new ShowError(`no hunk ${id} in this snapshot`);
}

async function showNode(graph: ChangeGraph, files: SnapshotFiles, id: string): Promise<string> {
  const node = graph.nodes.find((n) => n.id === id);
  if (node === undefined) throw new ShowError(`no node ${id} in this snapshot`);
  const out = [`# ${nodeLine(node)}`];
  const name = (nodeId: string) =>
    quotePath(graph.nodes.find((n) => n.id === nodeId)?.displayName ?? nodeId);
  const edges = graph.codeEdges.filter(
    (e) => e.to === id || (e.granularity === 'entity' && e.from === id),
  );
  if (edges.length > 0) {
    out.push('', 'Code edges:', ...edges.map((e) => `- ${edgeLine(e, name, graph)}`));
  }
  for (const side of ['new', 'old'] as const) {
    const range = side === 'new' ? node.newRange : node.oldRange;
    if (range === null) continue;
    const path = side === 'new' ? node.path : (node.oldPath ?? node.path);
    out.push('', `${side === 'new' ? 'New' : 'Old'} side, ${quotePath(path)}:`);
    out.push(await numbered(files, path, side, range.startLine, range.endLine));
  }
  if (node.newRange === null && node.oldRange === null) {
    out.push(
      '',
      `A ${node.kind} node: fetch its hunks, or read the file with --file ${quotePath(node.path)}.`,
    );
  }
  return `${out.join('\n')}\n`;
}

async function showEdge(graph: ChangeGraph, files: SnapshotFiles, id: string): Promise<string> {
  const edge = graph.codeEdges.find((e) => e.id === id);
  if (edge === undefined) throw new ShowError(`no edge ${id} in this snapshot`);
  const name = (nodeId: string) =>
    quotePath(graph.nodes.find((n) => n.id === nodeId)?.displayName ?? nodeId);
  const out = [`# ${edgeLine(edge, name, graph)}`];
  const records = graph.evidence.filter((r) => edge.evidenceIds.includes(r.id));
  const sites = new Map<string, typeof records>();
  for (const r of records) {
    const key = `${r.location.side} ${quotePath(r.location.path)}:${r.location.range.startLine}`;
    sites.set(key, [...(sites.get(key) ?? []), r]);
  }
  for (const [key, hits] of sites) {
    const { path, side, range } = hits[0]!.location;
    out.push('', `Hit on the ${key}:`);
    for (const r of hits) {
      out.push(`- ${r.method} ${r.outcome}${r.detail === null ? '' : `: ${r.detail}`}`);
    }
    const start = Math.max(1, range.startLine - SITE_CONTEXT);
    out.push(await numbered(files, path, side, start, range.endLine + SITE_CONTEXT));
  }
  return `${out.join('\n')}\n`;
}

async function showFile(
  files: SnapshotFiles,
  path: string,
  side: Side,
  lines: { start: number; end: number } | null,
): Promise<string> {
  const start = lines?.start ?? 1;
  const end = lines?.end ?? Infinity;
  return `# ${quotePath(path)}, ${side} side\n\n${await numbered(files, path, side, start, end)}\n`;
}

/** Lines `start`–`end` of a file, numbered and redacted, at most MAX_SHOW_LINES of them. */
async function numbered(
  files: SnapshotFiles,
  path: string,
  side: Side,
  start: number,
  end: number,
): Promise<string> {
  const sensitive = sensitiveFile(path);
  if (sensitive !== null) return `Not shown: withheld: ${sensitive}.`;
  const content = await files.read(side, path);
  if (content === null) {
    throw new ShowError(
      `${quotePath(path)} has no text content on the ${side} side of this snapshot`,
    );
  }
  const all = content.replace(/\n$/, '').split('\n');
  if (start > all.length)
    throw new ShowError(`${quotePath(path)} has ${all.length} lines on the ${side} side`);
  const wanted = Math.min(end, all.length);
  const last = Math.min(wanted, start + MAX_SHOW_LINES - 1);
  const width = String(last).length;
  const body = all
    .slice(start - 1, last)
    .map((line, i) => `${String(start + i).padStart(width)}  ${line}`)
    .join('\n');
  let text = redactSecrets(body, width + 2).text;
  if (last < wanted) {
    text += `\n… ${wanted - last} more lines; ask for them with --lines ${last + 1}-${Math.min(wanted, last + MAX_SHOW_LINES)}`;
  }
  return text;
}
