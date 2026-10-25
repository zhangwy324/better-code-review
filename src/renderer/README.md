# Renderer

Makes the one self-contained `review.html` (#28; design reference §8.7, §12.1 Option A, §14.2; MVP spec D7).

| File | Contents |
|---|---|
| `embed.ts` | `DATA_ELEMENT_IDS`, `scriptJson()` and `dataScripts()`: how the data sits in the page. The viewer imports it too |
| `render.ts` | `renderReview(template, documents)` returns the page; `writeReview(dir)` writes `<dir>/review.html` from the `changes.json`, `graph.json` and `plan.json` there, which stay next to it for the agent and for debugging. It throws `ViewerNotBuiltError` when there is no `dist/viewer/index.html` |

## Who calls it (#34)

- **`generate`** writes `review.html` last, with the fallback plan, so the CLI alone goes from a target to a page (MVP spec D8). In a checkout that hasn't run `npm run build` it warns and writes none, removing any older one, so a stale page is never left beside new data.
- **`render --dir <dir> [--open]`** rewrites it once the agent's plan is in: the skill's step after `validate` (design reference §11.2 steps 6–7). It checks `plan.json` as `validate` does and fails, writing nothing, if the plan is invalid. The page gets the validated plan, with any homeless nodes in Ungrouped; `plan.json` keeps the agent's text, since only the validator may make the `ungrouped` group. `--open` hands the page to the system's opener (`open`, `explorer.exe` or `xdg-open`, `src/cli/open.ts`); if that fails it says so and still exits 0.

The review directory then holds what §20 step 7 shows: `changes.json`, `graph.json`, `plan.json` and `review.html`, plus `generate`'s planner files.

## The page

`npm run build` makes the template, `dist/viewer/index.html` (`vite.config.ts`). It is the viewer with everything inline:

- the script, in one `<script type="module">`, and the styles, in one `<style>`. The build fails if either contains `</script`, `</style` or `<!--`, since those would end the element early;
- the notices for the code bundled in it (ADR 0002): this project's `LICENSE`, then the licences Vite's `build.license` collects from the bundled dependencies. They are an HTML comment at the end of `<head>`, after the charset, with LF line endings whatever the checkout or the packages use, so the page's bytes don't depend on them (#111);
- a Content-Security-Policy that allows that one script (by its SHA-256), inline styles and `data:` images, and nothing else: `default-src 'none'`. A browser makes no request for the page, even if a later viewer change tried to fetch. `zod-config.ts` turns off zod's `eval`, which the policy also blocks.

`renderReview()` adds the three data elements before the last `</body>`. `scriptJson()` escapes every `<`, U+2028 and U+2029, so repository or model text can't close its element, open a comment or start a tag. Nothing else in the page depends on the review, so the same documents and build give the same bytes.

## Tests

`render.test.ts` builds the viewer with Vite into a temporary directory (`viewer.test-helper.ts`), so it doesn't need `npm run build` first. It renders documents full of `</script>`, `<!--`, `</body>`, `<img onerror>`, U+2028 and U+2029, parses the page with `parse5` as a browser would, and checks:

- no element came from the data, and each data element reads back unchanged;
- no element has a `src` or `href`, the styles have no `url(` or `@import`, and the policy names the script's hash and no host;
- the notices list every bundled package;
- a second build and a second render give identical bytes, and so does a build whose `LICENSE` has CRLF line endings (#111).

`src/cli/render.test.ts` is the end-to-end test (#34 acceptance): `generate --local` on the signature fixture's uncommitted change writes a `review.html` whose embedded documents pass the viewer's own load checks, then an agent plan with a homeless node is rendered with Ungrouped made. It also checks that `render` refuses an invalid plan and leaves the page alone, and that `--open` failures are only reported.
