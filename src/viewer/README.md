# Viewer

The interactive review workspace inside `review.html` (design reference §6, §8.7, §11.3; MVP spec D1–D7). It is a prebuilt React app: every review uses the same code, and only the embedded data changes. Issue #27 is the shell. The graph (#30), diffs (#29), outline and file views (#31), progress (#32) and comments (#33) build on it.

| File | Contents |
|---|---|
| `data.ts` | `loadReviewData()`: reads and validates the embedded `changes.json`, `graph.json` and `plan.json` |
| `model.ts` | `buildModel()`: lookups by ID, home groups and coverage, built once |
| `state.tsx` | `ReviewProvider`, `useModel()`, and the selection every view shares (`useSelection()`) |
| `App.tsx` | The layout: header over three resizable panes, or the load error |
| `Header.tsx`, `Outline.tsx`, `Canvas.tsx`, `Detail.tsx` | The panes. `Canvas.tsx` is a placeholder until #30 |
| `Diff.tsx`, `diff.ts` | The diff component and its model: hunks exactly as the patch has them, with expandable context (below) |
| `highlight.ts` | Syntax highlighting with the Lezer parsers, by `GraphFile.language` |
| `main.tsx`, `index.html`, `styles.css` | The entry point, page and styles |
| `zod-config.ts` | Turns off zod's `eval`, which the page's Content-Security-Policy forbids. `main.tsx` imports it first |

## Data

The page carries each document in an inert element, `<script type="application/json" id="bcr-changes">` and likewise `bcr-graph` and `bcr-plan` (spec D7). [`src/renderer/embed.ts`](../renderer/embed.ts) defines them, for the viewer and the writers: its `scriptJson()` escapes every `<`, so no repository text can close the element. The viewer never fetches anything.

`loadReviewData()` parses each document with `parseContract()` and checks that all three share one snapshot. A missing element, bad JSON, another build's `schemaVersion` or a schema mismatch shows an error page instead of the app. The viewer imports the schemas from `src/schemas/contracts.ts`, not `index.ts`, because `index.ts` also exports the Node-only `ids.ts`.

## Diffs

`<Diff file hunkIds language>` shows some or all hunks of one file. It takes everything as props, so the detail pane uses it now and the file view (#31) and graph nodes can too. The detail pane shows a node's hunks, or one hunk.

- **Every hunk line is a line of `hunk.patch`** (spec invariant 5): `hunkRows()` splits the patch on `\n` and nothing else, so tabs, trailing whitespace, a CRLF's `\r`, unicode and "\ No newline at end of file" all show as Git wrote them. The `@@` line, then each row's prefix cell and code cell, joined with newlines, give back the patch. Trailing whitespace and the `\r` are wrapped in spans the styles make visible, without adding text. Long lines don't wrap; the diff scrolls sideways.
- **Expanded context comes from the file's content** (`changes.json` carries both sides, spec D7). Before, between and after the hunks, the unchanged lines sit behind "Show" buttons that reveal 20 lines at a time or all of them, up to the whole file. A gap never extends past a neighbouring hunk, even one not shown, so a changed line never appears as context. When content was omitted (binary, over the size cap or not UTF-8) the diff says so and shows the patch alone.
- **Rows are line-anchored:** each has `data-old-line` and `data-new-line`, and each hunk's `<tbody>` its `data-hunk-id`, for comments (#33, spec D4).
- **Syntax highlighting** parses each side's whole file, so lines inside a multi-line string or comment are right. It only adds classes to spans of the patch text, and only where the file's line matches that text. The parsers are Lezer's (MIT, the ones CodeMirror uses): plain JavaScript, which the page's policy allows. We don't use CodeMirror merge view, because it computes its own diff instead of showing Git's hunks (spec D3).

## Untrusted text

Repository text (paths, code, PR titles) and model text (plan titles, descriptions, explanations) are rendered only as React text, so they are never HTML or script (spec invariant 6). ESLint enforces this in viewer code: `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` and `createContextualFragment` are errors, and so is any `node:` import. `App.test.tsx` renders a plan and graph with `<img onerror>` and `<script>` in their text.

## Building and developing

- `npm run build` bundles the app into one page, `dist/viewer/index.html`, with Vite (`vite.config.ts`): the script, styles and licence notices are inline, and a Content-Security-Policy allows nothing else. The [renderer](../renderer/README.md) adds a review's data to it to make `review.html`.
- `npm run typecheck` checks the viewer with `src/viewer/tsconfig.json`, which adds the DOM and JSX. The root tsconfig excludes this folder.
- `npm run viewer -- <review-dir>` serves the app with hot reload and the data of a directory `generate` wrote. For a fixture:

  ```sh
  npm run fixtures -- signature /tmp/sig
  (cd /tmp/sig && better-code-review generate --commit main --no-lsp --out /tmp/sig-out)
  npm run viewer -- /tmp/sig-out
  ```

## Tests

Viewer tests run under jsdom (`// @vitest-environment jsdom`) with Testing Library. `App.test.tsx` runs `generate` on the signature fixture in a child process, because jsdom replaces Node's `URL`, which the analyzers need. It then embeds the JSON as `review.html` would and checks the header, outline, shared selection, inert text and load errors, with `fetch` and `XMLHttpRequest` spied on to show nothing goes to the network.

`Diff.test.tsx` does the same on a repository of awkward content: tabs, trailing whitespace, CRLF, no newline at the end, unicode, a 20,000-character line, HTML-looking text and a file that is not UTF-8. It checks that every hunk's rows give back its patch byte for byte, that expanding everything shows each old and new line once with the right number, and that context never includes a changed line.
