# Renderer

Makes the one self-contained `review.html` (#28; design reference §8.7, §12.1 Option A, §14.2; MVP spec D7). The CLI command and skill step that call it are #34.

| File | Contents |
|---|---|
| `embed.ts` | `DATA_ELEMENT_IDS`, `scriptJson()` and `dataScripts()`: how the data sits in the page. The viewer imports it too |
| `render.ts` | `renderReview(template, documents)` returns the page; `writeReview(dir)` writes `<dir>/review.html` from the `changes.json`, `graph.json` and `plan.json` there, which stay next to it for the agent and for debugging |

## The page

`npm run build` makes the template, `dist/viewer/index.html` (`vite.config.ts`). It is the viewer with everything inline:

- the script, in one `<script type="module">`, and the styles, in one `<style>`. The build fails if either contains `</script`, `</style` or `<!--`, since those would end the element early;
- the notices for the code bundled in it (ADR 0002): this project's `LICENSE`, then the licences Vite's `build.license` collects from the bundled dependencies. They are an HTML comment at the end of `<head>`, after the charset;
- a Content-Security-Policy that allows that one script (by its SHA-256), inline styles and `data:` images, and nothing else: `default-src 'none'`. A browser makes no request for the page, even if a later viewer change tried to fetch. `zod-config.ts` turns off zod's `eval`, which the policy also blocks.

`renderReview()` adds the three data elements before the last `</body>`. `scriptJson()` escapes every `<`, U+2028 and U+2029, so repository or model text can't close its element, open a comment or start a tag. Nothing else in the page depends on the review, so the same documents and build give the same bytes.

## Tests

`render.test.ts` builds the viewer with Vite into a temporary directory, so it doesn't need `npm run build` first. It renders documents full of `</script>`, `<!--`, `</body>`, `<img onerror>`, U+2028 and U+2029, parses the page with `parse5` as a browser would, and checks:

- no element came from the data, and each data element reads back unchanged;
- no element has a `src` or `href`, the styles have no `url(` or `@import`, and the policy names the script's hash and no host;
- the notices list every bundled package;
- a second build and a second render give identical bytes.
