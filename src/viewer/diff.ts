// The diff view's model (#29): the rows of a hunk, taken from its patch text unchanged, and the
// unchanged lines around it that the reviewer can expand, taken from the file's content (spec D3,
// D7). Nothing here reconstructs or re-diffs code: every hunk line is a line of `hunk.patch`.
import type { DiffHunk, FileChange } from '../schemas/changeset.ts';
import type { Side } from '../schemas/common.ts';

export interface DiffRow {
  /** `marker` is a "\ No newline at end of file" line, which belongs to neither side. */
  kind: 'context' | 'added' | 'removed' | 'marker';
  /** The patch line's first character, e.g. `+`. A space for expanded context. */
  prefix: string;
  /** The rest of the line, without its newline: `prefix + text` is the patch line. */
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

const KINDS: Record<string, DiffRow['kind']> = {
  ' ': 'context',
  '+': 'added',
  '-': 'removed',
  '\\': 'marker',
};

/**
 * The hunk's `@@` line and its other lines, in patch order. Joining the header and each row's
 * `prefix + text` with newlines gives back `hunk.patch` without its final newline.
 */
export function hunkRows(hunk: DiffHunk): { header: string; rows: DiffRow[] } {
  const lines = hunk.patch.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  const rows = lines.slice(1).map((line): DiffRow => {
    const prefix = line.slice(0, 1);
    const kind = KINDS[prefix] ?? 'marker';
    const old = kind === 'context' || kind === 'removed' ? oldLine++ : null;
    const nu = kind === 'context' || kind === 'added' ? newLine++ : null;
    return { kind, prefix, text: line.slice(1), oldLine: old, newLine: nu };
  });
  return { header: lines[0]!, rows };
}

/**
 * The unchanged lines between two hunks of a file (or a hunk and the file's start or end), on the
 * side whose content `contextSide()` chose. Line `n` of that side is line `n + offset` of the other.
 */
export interface Gap {
  /** 1-based and inclusive; empty when `from > to`. */
  from: number;
  to: number;
  offset: number;
}

/**
 * The side expanded context is read from: the new side, or the old one for a deleted file. Null
 * when the file's content wasn't captured (binary, over the size cap or not UTF-8), so there is
 * no context to show beyond the patch.
 */
export function contextSide(file: FileChange): Side | null {
  if (file.newContent !== null) return 'new';
  if (file.oldContent !== null) return 'old';
  return null;
}

/** A file's lines, split on `\n` only, so a `\r` stays at the end of its line as in the patch. */
export function contentLines(content: string): string[] {
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * The gaps of `file` on `side`: gap `i` is the one before `file.hunks[i]`, and the last gap is the
 * one after the last hunk. Hunks are in diff order, so their ranges ascend on both sides.
 */
export function gaps(file: FileChange, side: Side, lineCount: number): Gap[] {
  // For each hunk, the number of lines before it and the line it ends on, on each side. Git gives
  // an empty range the number of the line before it, e.g. `-0,0` for an added file.
  const bounds = file.hunks.map((h) => {
    const oldBefore = h.oldLines > 0 ? h.oldStart - 1 : h.oldStart;
    const newBefore = h.newLines > 0 ? h.newStart - 1 : h.newStart;
    return {
      old: { before: oldBefore, end: oldBefore + h.oldLines },
      new: { before: newBefore, end: newBefore + h.newLines },
    };
  });
  const other: Side = side === 'new' ? 'old' : 'new';
  const result: Gap[] = [];
  for (let i = 0; i <= bounds.length; i++) {
    const above = bounds[i - 1];
    const below = bounds[i];
    result.push({
      from: (above?.[side].end ?? 0) + 1,
      to: below?.[side].before ?? lineCount,
      offset:
        below !== undefined
          ? below[other].before - below[side].before
          : above !== undefined
            ? above[other].end - above[side].end
            : 0,
    });
  }
  return result;
}

/** The context row for line `line` of `side`, whose text is `text`. */
export function contextRow(gap: Gap, side: Side, line: number, text: string): DiffRow {
  const other = line + gap.offset;
  return {
    kind: 'context',
    prefix: ' ',
    text,
    oldLine: side === 'old' ? line : other,
    newLine: side === 'new' ? line : other,
  };
}

/** How many lines of a gap show from its top (below the hunk above) and from its bottom. */
export interface Expansion {
  top: number;
  bottom: number;
}

/**
 * The expansion of each gap that reveals `lines`, e.g. the lines of comments on expanded
 * context, so they show again when the diff is shown again. A line is revealed from the hunk
 * above its gap when that hunk is shown (`isShown(i - 1)`), else from the one below.
 */
export function revealing(
  fileGaps: readonly Gap[],
  side: Side,
  lines: readonly { side: Side; line: number }[],
  isShown: (hunkIndex: number) => boolean,
): Record<number, Expansion> {
  const result: Record<number, Expansion> = {};
  for (const target of lines) {
    fileGaps.forEach((gap, i) => {
      const line = target.side === side ? target.line : target.line - gap.offset;
      if (line < gap.from || line > gap.to) return;
      const e = (result[i] ??= { top: 0, bottom: 0 });
      if (isShown(i - 1)) e.top = Math.max(e.top, line - gap.from + 1);
      else if (isShown(i)) e.bottom = Math.max(e.bottom, gap.to - line + 1);
    });
  }
  return result;
}

/**
 * A character that shows as nothing, or reorders the text around it, so that code can read
 * differently from how it runs ("Trojan Source", CVE-2021-42574; #35, #106). `index` and `length`
 * are in UTF-16 code units of the text.
 */
export interface HiddenChar {
  index: number;
  length: number;
  kind: 'bidi' | 'invisible';
  /** The code point, e.g. `U+200B`. */
  code: string;
}

/** The Unicode bidirectional controls: embeddings, overrides, isolates and the marks. */
const BIDI = /^[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]$/u;

/**
 * The bidirectional controls, then characters that show as nothing (or as blank space) but are
 * not whitespace: the soft hyphen, the combining grapheme joiner, the Hangul fillers (valid in
 * JavaScript identifiers), the Mongolian vowel separator, zero-width spaces and non-joiners, the
 * word joiner and invisible operators, the deprecated format characters, a byte order mark,
 * interlinear annotation, tag characters and the supplementary variation selectors.
 *
 * A zero-width joiner is marked unless it joins two emoji, which is how they combine and which
 * shows. The variation selectors of the Basic Multilingual Plane are marked only in a run: one
 * after a character picks its form, as U+FE0F does for an emoji, but a run of them is how text
 * hides data.
 */
const HIDDEN =
  // eslint-disable-next-line no-misleading-character-class -- matching combining characters one by one is the point
  /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u00ad\u034f\u115f\u1160\u180e\u200b\u200c\u2060-\u2064\u206a-\u206f\u3164\ufeff\uffa0\ufff9-\ufffb\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]|\u200d(?!\p{Extended_Pictographic})|(?<!\p{Extended_Pictographic}[\ufe0f\u{1f3fb}-\u{1f3ff}]?)\u200d|[\ufe00-\ufe0f]{2,}/gu;

/** Each bidirectional control and invisible character in `text`, in order. */
export function hiddenChars(text: string): HiddenChar[] {
  const found: HiddenChar[] = [];
  for (const match of text.matchAll(HIDDEN)) {
    let index = match.index;
    // A run of variation selectors is one match; each of its characters is marked.
    for (const char of match[0]) {
      const code = `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
      const kind = BIDI.test(char) ? 'bidi' : 'invisible';
      found.push({ index, length: char.length, kind, code });
      index += char.length;
    }
  }
  return found;
}
