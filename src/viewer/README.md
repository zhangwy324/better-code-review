# Viewer

The interactive review workspace inside `review.html` (design reference §6, §8.7, §11.3; MVP spec D1–D7). It is a prebuilt React app: every review uses the same code, and only the embedded data changes. Issue #27 is the shell. The graph (#30), diffs (#29), outline and file views (#31), progress (#32) and comments (#33) build on it.

| File | Contents |
|---|---|
| `data.ts` | `loadReviewData()`: reads and validates the embedded `changes.json`, `graph.json` and `plan.json` |
| `model.ts` | `buildModel()`: lookups by ID, home groups and coverage, built once |
| `state.tsx` | `ReviewProvider`, `useModel()`, and the selection every view shares (`useSelection()`) |
| `App.tsx` | The layout: header over three resizable panes, or the load error |
| `Header.tsx`, `Outline.tsx`, `Canvas.tsx`, `Detail.tsx` | The panes. `Canvas.tsx` is a placeholder until #30 |
| `main.tsx`, `index.html`, `styles.css` | The entry point, page and styles |
| `zod-config.ts` | Turns off zod's `eval`, which the page's Content-Security-Policy forbids. `main.tsx` imports it first |

## Data

The page carries each document in an inert element, `<script type="application/json" id="bcr-changes">` and likewise `bcr-graph` and `bcr-plan` (spec D7). [`src/renderer/embed.ts`](../renderer/embed.ts) defines them, for the viewer and the writers: its `scriptJson()` escapes every `<`, so no repository text can close the element. The viewer never fetches anything.

`loadReviewData()` parses each document with `parseContract()` and checks that all three share one snapshot. A missing element, bad JSON, another build's `schemaVersion` or a schema mismatch shows an error page instead of the app. The viewer imports the schemas from `src/schemas/contracts.ts`, not `index.ts`, because `index.ts` also exports the Node-only `ids.ts`.

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
