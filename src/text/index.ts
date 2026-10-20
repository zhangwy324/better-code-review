// Small helpers for the text the tool writes for people and agents: summary.txt, the planner input
// and the fallback plan. Numbers always get thousands separators (`1,234`), whatever the locale.

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
