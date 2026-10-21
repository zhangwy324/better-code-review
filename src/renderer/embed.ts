// The review data inside review.html (MVP spec D7): one inert `<script type="application/json">`
// element per document. The renderer (render.ts) and `npm run viewer` write them; the viewer
// reads them (src/viewer/data.ts). Nothing here needs a browser or Node, so both sides import it.

/** The `id` of each document's element. */
export const DATA_ELEMENT_IDS = {
  changes: 'bcr-changes',
  graph: 'bcr-graph',
  plan: 'bcr-plan',
} as const;

export type DataName = keyof typeof DATA_ELEMENT_IDS;

/**
 * `value` as JSON that is safe inside a `<script>` element. Every `<` is escaped, so repository
 * or model text can never close the element (`</script>`) or open a comment (`<!--`), and
 * `JSON.parse` reads it back unchanged. U+2028 and U+2029 are escaped too: JSON allows them raw,
 * but older JavaScript engines end a string literal at them, should the text ever be read as JS.
 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

/** The three data elements, as HTML to put in the page's `<head>` or `<body>`. */
export function dataScripts(documents: Record<DataName, unknown>): string {
  return (Object.keys(DATA_ELEMENT_IDS) as DataName[])
    .map(
      (name) =>
        `<script type="application/json" id="${DATA_ELEMENT_IDS[name]}">${scriptJson(documents[name])}</script>`,
    )
    .join('\n');
}
