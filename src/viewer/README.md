# Viewer

The interactive review workspace inside `review.html` (design reference §6, §8.7, §11.3; MVP spec D1–D7). It is a prebuilt React app: every review uses the same code, and only the embedded data changes. Issue #27 is the shell. The graph (#30), diffs (#29), outline and file views (#31), progress (#32) and comments (#33) build on it.

| File | Contents |
|---|---|
| `data.ts` | `loadReviewData()`: reads and validates the embedded `changes.json`, `graph.json` and `plan.json` |
| `model.ts` | `buildModel()`: lookups by ID, home groups, coverage and links (code edges and inferred relationships), built once |
| `state.tsx` | `ReviewProvider`, `useModel()`, and the selection every view shares (`useSelection()`): a group, node, hunk or the links of one canvas edge |
| `App.tsx` | The layout: header over three resizable panes, or the load error |
| `Header.tsx`, `Outline.tsx`, `Views.tsx`, `Detail.tsx` | The panes. `Views.tsx` is the center pane's tabs: `Canvas.tsx`, `Guided.tsx` and `Files.tsx` (below) |
| `scroll.ts` | `useScrollToSelection()`: brings the selection into view in the guided and file views |
| `canvas.ts` | `canvasGraph()`: the graph's groups, nodes and edges for the groups expanded, laid out with dagre (below) |
| `Diff.tsx`, `diff.ts` | The diff component and its model: hunks exactly as the patch has them, with expandable context (below) |
| `highlight.ts` | Syntax highlighting with the Lezer parsers, by `GraphFile.language` |
| `main.tsx`, `index.html`, `styles.css` | The entry point, page and styles |
| `zod-config.ts` | Turns off zod's `eval`, which the page's Content-Security-Policy forbids. `main.tsx` imports it first |

## Data

The page carries each document in an inert element, `<script type="application/json" id="bcr-changes">` and likewise `bcr-graph` and `bcr-plan` (spec D7). [`src/renderer/embed.ts`](../renderer/embed.ts) defines them, for the viewer and the writers: its `scriptJson()` escapes every `<`, so no repository text can close the element. The viewer never fetches anything.

`loadReviewData()` parses each document with `parseContract()` and checks that all three share one snapshot. A missing element, bad JSON, another build's `schemaVersion` or a schema mismatch shows an error page instead of the app. The viewer imports the schemas from `src/schemas/contracts.ts`, not `index.ts`, because `index.ts` also exports the Node-only `ids.ts`.

## Graph

`Canvas.tsx` draws the graph with React Flow (design reference §6.1, §6.4; spec D1, D6, D12). `canvasGraph(model, expanded)` in `canvas.ts` decides what it shows, as a pure function the tests call directly:

- **Groups start collapsed**, one node each, numbered in the plan's reading order (MVP has no reading-order edges, spec D6). Expanding one replaces it with a box holding its changes and child groups. Selecting a group, or a change, in any pane expands its groups and brings it into view.
- **Edges go from a changed entity to its changed callers** (callee → callers, spec D1), labelled e.g. `called by`. An edge to or from a collapsed group stands for all its members' links, and is aggregated, e.g. `called by ×3`; links inside a collapsed group show when it is expanded. A test-file edge ends at the first node in the test file.
- **Each layer and provenance has its own style** (`Link['style']` in `model.ts`, design reference §13.1): `verified` and `possible` code edges, `possible` ones the agent judged real (`inferred`) or not real (`rejected`, still shown), and the plan's inferred relationships. Hovering an edge shows each link's direction and provenance; clicking it shows them and the evidence in the detail pane.
- **Navigation along edges:** a selected change's detail lists its related changes. Each selects the change at the other end (and the canvas moves to it) or the link's evidence.
- **Only changed entities are nodes.** Unchanged callers are not analysed, and the canvas says so above the graph (spec D12).
- **Layout** is dagre's layered layout, left to right, with expanded groups as compound nodes. It runs again on every expand or collapse, and `stableLayout()` keeps what the reviewer saw (#115): every group stays where it was, dragged or not, a group that grows pushes its neighbours only as far as they need to clear it, and collapsing it moves them back. Dragged positions last for the session and are not saved (spec). Nodes have fixed sizes (`SIZES`, matching `styles.css`), so the layout needs no measuring. We use dagre rather than elkjs: it is MIT, and much smaller (ADR 0002).
- **Change nodes show a preview, not the diff:** kind, path, `+a −d`, and "showing N of M" when the analyzer capped a relationship. Selecting one opens its diff in the detail pane (spec D3 defers diffs inside graph nodes).

## Views

The center pane has three views behind tabs (design reference §6.1, spec D3): the graph, the guided review and the files. The selection lives in `ReviewProvider`, above the tabs, so all three and the outline and detail pane share it; comments (#33) and progress (#32) belong there too. A hidden view stays mounted inside React's `<Activity>`, so the canvas keeps its expanded groups and dragged nodes and a diff its expanded context. Showing a view again re-runs its effects, which scroll it to the selection.

- **Guided review** (`Guided.tsx`) is the reading surface for the plan: its groups in reading order, numbered as on the canvas, child groups nested in their parent, each with its description and the diff of every change whose home it is. A change homed elsewhere is a reference that selects it, not a copy (spec D2).
- **Files** (`Files.tsx`) is the familiar file-by-file diff, for fallback and auditability (§9.8). It shows every file of `changes.json` with all its hunks, read from the change set and not the plan or graph, so every hunk is reachable there whatever the plan's quality. It also says which files have no hunks (a pure rename, a mode change) and which untracked files were left out.

## Diffs

`<Diff file hunkIds language>` shows some or all hunks of one file. It takes everything as props, so the detail pane, the guided review and the file view all use it, and graph nodes can too. The detail pane shows a node's hunks, or one hunk; the file view all of a file's.

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

Viewer tests run under jsdom (`// @vitest-environment jsdom`) with Testing Library. `testing.tsx` holds what they share: `generateReview` runs `generate` on a fixture repository in a child process, because jsdom replaces Node's `URL`, which the analyzers need; `renderEmbedded` embeds the JSON as `review.html` would and renders the app; and importing it installs the `ResizeObserver` and `DOMMatrixReadOnly` stand-ins jsdom lacks. ESLint lets it, like the tests, import `node:` modules and set `innerHTML`. On the signature fixture, `App.test.tsx` checks the header, outline, shared selection and inert text, with `fetch` and `XMLHttpRequest` spied on to show nothing goes to the network, and `data.test.tsx` checks the load errors. `Views.test.tsx` checks the #31 acceptance: the guided review follows the plan's order and nesting, the file view shows every hunk even when the plan has no groups, and switching views keeps the selection and the canvas's expanded groups. `Canvas.test.tsx` checks the #30 acceptance: `formatPrice` has edges to its changed callers, `emailSummary` is not shown, and the canvas says unchanged callers are not analysed. It also checks collapsed groups, aggregation, expanding and navigation along edges to the evidence.

`Diff.test.tsx` does the same on a repository of awkward content: tabs, trailing whitespace, CRLF, no newline at the end, unicode, a 20,000-character line, HTML-looking text and a file that is not UTF-8. It checks that every hunk's rows give back its patch byte for byte, that expanding everything shows each old and new line once with the right number, and that context never includes a changed line.
