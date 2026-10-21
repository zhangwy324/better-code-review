// The diff component (#29; design reference §6.3, §8.7; spec D3): some or all hunks of one file,
// each line exactly as the patch has it, with the unchanged lines between them expandable from the
// file's content. It takes everything it shows as props, so the detail pane, the file view (#31)
// and graph nodes can all use it. Every row carries its line numbers as `data-old-line` and
// `data-new-line`, for comments to anchor to (spec D4).
import { type ReactNode, useMemo, useState } from 'react';
import type { FileChange } from '../schemas/changeset.ts';
import type { Side } from '../schemas/common.ts';
import { count } from '../text/index.ts';
import {
  contentLines,
  contextRow,
  contextSide,
  type DiffRow,
  type Gap,
  gaps,
  hunkRows,
} from './diff.ts';
import { Highlighter, type Token } from './highlight.ts';

/** How many unchanged lines one click reveals. */
const STEP = 20;

const OMITTED_NOTES: Record<NonNullable<FileChange['contentOmitted']>, string> = {
  binary: 'Binary file: there is no text diff.',
  'too-large': 'The file is over the size cap, so only the changed lines and their context show.',
  'not-utf8':
    'The file is not valid UTF-8: invalid bytes show as �, and only the changed lines and their context show.',
};

interface Props {
  file: FileChange;
  /** The hunks to show, in any order; they show in file order. All of the file's by default. */
  hunkIds?: readonly string[] | undefined;
  /** The file's grammar name (`GraphFile.language`), or null for plain text. */
  language: string | null;
  /** Makes each hunk's `@@` line a button that selects the hunk. */
  onSelectHunk?: ((id: string) => void) | undefined;
}

type Expansion = { top: number; bottom: number };

export function Diff({ file, hunkIds, language, onSelectHunk }: Props) {
  const side = contextSide(file);
  const lines = useMemo(() => {
    const content = side === 'new' ? file.newContent : side === 'old' ? file.oldContent : null;
    return content === null ? [] : contentLines(content);
  }, [file, side]);
  const fileGaps = useMemo(
    () => (side === null ? null : gaps(file, side, lines.length)),
    [file, side, lines],
  );
  const highlighters = useMemo(
    () => ({
      old: file.oldContent === null ? null : Highlighter.for(file.oldContent, language),
      new: file.newContent === null ? null : Highlighter.for(file.newContent, language),
    }),
    [file, language],
  );
  const [expanded, setExpanded] = useState<Record<number, Expansion>>({});

  const shown = new Set(hunkIds ?? file.hunks.map((h) => h.id));
  const isShown = (i: number) => file.hunks[i] !== undefined && shown.has(file.hunks[i].id);
  const tokens = (row: DiffRow) => rowTokens(row, highlighters);

  // Gap i is before hunk i; it shows when a hunk next to it does. A run of hunks left out between
  // shown ones becomes one separator row.
  const parts: ReactNode[] = [];
  let emitted = false;
  let skipped = 0;
  const flushSkipped = () => {
    if (skipped > 0) {
      parts.push(
        <tbody key={`skip-${parts.length}`} className="skipped">
          <tr>
            <td colSpan={4}>⋯ {count(skipped, 'other hunk')}</td>
          </tr>
        </tbody>,
      );
    }
    skipped = 0;
  };
  for (let i = 0; i <= file.hunks.length; i++) {
    const up = isShown(i - 1);
    const down = isShown(i);
    const gap = fileGaps?.[i];
    if ((up || down) && side !== null && gap !== undefined && gap.from <= gap.to) {
      flushSkipped();
      parts.push(
        <GapRows
          key={`gap-${i}`}
          gap={gap}
          side={side}
          lines={lines}
          up={up}
          down={down}
          expansion={expanded[i] ?? { top: 0, bottom: 0 }}
          onExpand={(e) => setExpanded((all) => ({ ...all, [i]: e }))}
          tokens={tokens}
        />,
      );
    }
    const hunk = file.hunks[i];
    if (hunk === undefined) break;
    if (!down) {
      if (emitted) skipped++;
      continue;
    }
    flushSkipped();
    emitted = true;
    const { header, rows } = hunkRows(hunk);
    parts.push(
      <tbody key={hunk.id} className="hunk" data-hunk-id={hunk.id}>
        <tr className="hunk-header">
          <td colSpan={3} />
          <td>
            {onSelectHunk === undefined ? (
              header
            ) : (
              <button type="button" className="link" onClick={() => onSelectHunk(hunk.id)}>
                {header}
              </button>
            )}
          </td>
        </tr>
        {rows.map((row, n) => (
          <Row key={n} row={row} tokens={tokens(row)} />
        ))}
      </tbody>,
    );
  }

  const path = file.newPath ?? file.oldPath;
  return (
    <div className="diff">
      {file.contentOmitted !== null && <p className="note">{OMITTED_NOTES[file.contentOmitted]}</p>}
      {parts.length > 0 && (
        <div className="diff-scroll">
          <table className="diff-table" data-path={path}>
            {parts}
          </table>
        </div>
      )}
    </div>
  );
}

/** A gap's revealed lines, and the buttons that reveal more, from whichever end has a hunk. */
function GapRows({
  gap,
  side,
  lines,
  up,
  down,
  expansion,
  onExpand,
  tokens,
}: {
  gap: Gap;
  side: Side;
  lines: string[];
  /** A shown hunk is above the gap, so lines can be revealed downward from it. */
  up: boolean;
  /** A shown hunk is below it, so lines can be revealed upward from it. */
  down: boolean;
  expansion: Expansion;
  onExpand: (expansion: Expansion) => void;
  tokens: (row: DiffRow) => Token[];
}) {
  const size = gap.to - gap.from + 1;
  const top = up ? Math.min(expansion.top, size) : 0;
  const bottom = down ? Math.min(expansion.bottom, size - top) : 0;
  const hidden = size - top - bottom;
  const rows = (from: number, to: number) => {
    const result: ReactNode[] = [];
    for (let line = from; line <= to; line++) {
      const row = contextRow(gap, side, line, lines[line - 1] ?? '');
      result.push(<Row key={line} row={row} tokens={tokens(row)} expanded />);
    }
    return result;
  };
  const all = () => onExpand(up ? { top: top + hidden, bottom } : { top, bottom: bottom + hidden });
  return (
    <tbody className="gap">
      {rows(gap.from, gap.from + top - 1)}
      {hidden > 0 && (
        <tr className="expand">
          <td colSpan={3} />
          <td>
            {count(hidden, 'unchanged line')}{' '}
            {hidden <= STEP ? (
              <button type="button" className="link" onClick={all}>
                Show
              </button>
            ) : (
              <>
                {up && (
                  <button
                    type="button"
                    className="link"
                    onClick={() => onExpand({ top: top + STEP, bottom })}
                  >
                    ↓ Show {STEP}
                  </button>
                )}{' '}
                {down && (
                  <button
                    type="button"
                    className="link"
                    onClick={() => onExpand({ top, bottom: bottom + STEP })}
                  >
                    ↑ Show {STEP}
                  </button>
                )}{' '}
                <button type="button" className="link" onClick={all}>
                  Show all
                </button>
              </>
            )}
          </td>
        </tr>
      )}
      {rows(gap.to - bottom + 1, gap.to)}
    </tbody>
  );
}

function Row({
  row,
  tokens,
  expanded = false,
}: {
  row: DiffRow;
  tokens: Token[];
  expanded?: boolean;
}) {
  return (
    <tr
      className={expanded ? `${row.kind} expanded` : row.kind}
      data-old-line={row.oldLine ?? undefined}
      data-new-line={row.newLine ?? undefined}
    >
      <td className="num">{row.oldLine}</td>
      <td className="num">{row.newLine}</td>
      <td className="prefix">{row.prefix}</td>
      <td className="code">
        <LineText text={row.text} tokens={tokens} />
      </td>
    </tr>
  );
}

/**
 * `text` exactly, split into spans: highlighted tokens, then any trailing whitespace, which is
 * marked so it can be seen. The carriage return of a CRLF line gets its own span, which the styles
 * show as `␍` without adding it to the text.
 */
function LineText({ text, tokens }: { text: string; tokens: Token[] }) {
  const body = text.endsWith('\r') ? text.slice(0, -1) : text;
  const end = body.trimEnd().length;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const t of tokens) {
    const to = Math.min(t.to, end);
    if (t.from < at || t.from >= to) continue;
    if (t.from > at) parts.push(text.slice(at, t.from));
    parts.push(
      <span key={t.from} className={t.classes}>
        {text.slice(t.from, to)}
      </span>,
    );
    at = to;
  }
  if (end > at) parts.push(text.slice(at, end));
  if (end < body.length) {
    parts.push(
      <span key="ws" className="trailing-ws">
        {body.slice(end)}
      </span>,
    );
  }
  if (body !== text) {
    parts.push(
      <span key="cr" className="cr">
        {'\r'}
      </span>,
    );
  }
  return parts;
}

/** Highlighting for a row from its side's whole file: the old side for removed lines. */
function rowTokens(row: DiffRow, highlighters: Record<Side, Highlighter | null>): Token[] {
  if (row.kind === 'removed' && row.oldLine !== null) {
    return highlighters.old?.line(row.oldLine, row.text) ?? [];
  }
  if (row.newLine !== null && highlighters.new !== null) {
    return highlighters.new.line(row.newLine, row.text);
  }
  if (row.oldLine !== null) return highlighters.old?.line(row.oldLine, row.text) ?? [];
  return [];
}
