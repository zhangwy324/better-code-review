// The review data inside review.html (MVP spec D7): one inert `<script type="application/json">`
// element per document. The viewer reads them (data.ts); the renderer (#28) and `npm run viewer`
// write them. Nothing here needs a browser or Node, so both sides can import it.

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
 * `JSON.parse` reads it back unchanged.
 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
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
