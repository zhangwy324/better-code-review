// What copying a selection from a diff puts on the clipboard (#109): the code of one side only.
// The unified diff interleaves removed and added rows, so a plain copy would mix the old and new
// code, and the browser's own copy can't tell them apart. The page shows the same text as before;
// only the clipboard's text differs.
import type { Side } from '../schemas/common.ts';

/** The rows of each kind that are on a side. Context is on both; a "\ No newline" marker on none. */
const ON_SIDE: Record<Side, readonly string[]> = {
  old: ['context', 'removed'],
  new: ['context', 'added'],
};

/**
 * The code a selection in the diff `table` copies, or null to leave the copy to the browser
 * because no code line is selected.
 *
 * The side is the one of the line the selection started on (its anchor), when that line is a
 * removed or added one; otherwise the side of the first changed line selected. Only that side's
 * lines are copied, each as much of it as is selected, joined with newlines. Line numbers, `+` and
 * `-` prefixes, `@@` lines, expansion controls and comments are left out, and so is the `\r` of a
 * CRLF line, which is the line's ending rather than its code.
 */
export function copiedCode(table: Element, selection: Selection): string | null {
  if (selection.isCollapsed) return null;
  const ranges = Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i));
  const rows = [...table.querySelectorAll('tr')].flatMap((tr) => {
    const cell = tr.querySelector(':scope > td.code');
    if (cell === null) return [];
    const parts = ranges.map((r) => clip(r, cell)).filter((t) => t !== null);
    return parts.length === 0 ? [] : [{ tr, text: parts.join('') }];
  });
  if (rows.length === 0) return null;
  const anchor = selection.anchorNode;
  const started = rows.find(({ tr }) => anchor !== null && tr.contains(anchor));
  const changed = [started, ...rows].find((r) => r !== undefined && sideOf(r.tr) !== null);
  const side = changed === undefined ? 'new' : sideOf(changed.tr)!;
  return rows
    .filter(({ tr }) => ON_SIDE[side].some((kind) => tr.classList.contains(kind)))
    .map(({ text }) => (text.endsWith('\r') ? text.slice(0, -1) : text))
    .join('\n');
}

/** The side of a removed or added row; null for any other. */
function sideOf(tr: Element): Side | null {
  if (tr.classList.contains('removed')) return 'old';
  if (tr.classList.contains('added')) return 'new';
  return null;
}

/**
 * The text of `cell` inside `range`, or null when the range doesn't reach into it. An empty line
 * that the range spans gives the empty string.
 */
function clip(range: Range, cell: Element): string | null {
  const part = cell.ownerDocument.createRange();
  part.selectNodeContents(cell);
  // A range that starts at or after the cell's end, or ends at or before its start, selects none
  // of it. (`compareBoundaryPoints` places `range`'s point relative to `part`'s.)
  if (range.compareBoundaryPoints(Range.END_TO_START, part) >= 0) return null;
  if (range.compareBoundaryPoints(Range.START_TO_END, part) <= 0) return null;
  if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0) {
    part.setStart(range.startContainer, range.startOffset);
  }
  if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) {
    part.setEnd(range.endContainer, range.endOffset);
  }
  return part.toString();
}
