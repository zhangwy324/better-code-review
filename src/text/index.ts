// Small helpers for the text the tool writes for people and agents: summary.txt, the planner input,
// the fallback plan and the viewer. Numbers always get thousands separators (`1,234`), whatever the
// locale.

/** What a reader must know about the graph's edges (spec D12). */
export const UNCHANGED_CALLERS_NOTE =
  'Only relationships between changed code are shown. Unchanged callers are not analysed.';

/** `n` and the noun for it, e.g. `1 file`, `1,234 files`. */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en')} ${n === 1 ? one : many}`;
}

/** `items` joined with commas, the first three and a count of the rest. */
export function list(items: readonly string[]): string {
  const shown = items.slice(0, 3).join(', ');
  return items.length > 3 ? `${shown} and ${(items.length - 3).toLocaleString('en')} more` : shown;
}

/** Each distinct item and how often it occurs, in order of first occurrence. */
export function occurrences<T extends string>(items: readonly T[]): [T, number][] {
  const counts = new Map<T, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts];
}

/** Each distinct item with its count when above one, e.g. `call ×2, import`. */
export function tally(items: readonly string[]): string {
  return occurrences(items)
    .map(([k, n]) => (n === 1 ? k : `${k} ×${n.toLocaleString('en')}`))
    .join(', ');
}

/**
 * Control characters but tab (C0, DEL, C1) and the Unicode bidirectional controls: in a path or
 * a title they could start a new line of the text, send a terminal escape or reorder what is
 * shown.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE = /[\0-\x08\n-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** `text` as a JSON string, with every unsafe character escaped, e.g. `"a\nb"`. */
export function quoted(text: string): string {
  return JSON.stringify(text).replace(
    UNSAFE,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/**
 * A repository path or name as one line of text for a terminal or a model (#35, design reference
 * §14.2). It is unchanged unless it holds an unsafe character; then, like Git's `core.quotePath`,
 * it is `quoted()`.
 */
export function quotePath(path: string): string {
  return path.match(UNSAFE) === null ? path : quoted(path);
}
