# Security

Better Code Review reads code that someone else wrote, often an agent, and makes a page from it. Everything it reads is **untrusted input**: repository files, the diff, file names, pull request titles and descriptions, the reviewer's comments, and everything the model writes, `plan.json` included (design reference §14.2). This file is the checklist of what keeps that input inert, and where each safeguard is enforced and tested (#35).

## Reporting a vulnerability

Please don't open a public issue. Report it privately through the repository's **Security** tab ("Report a vulnerability"), with the input that shows it, such as a file name, a file or a plan.

## Checklist

Each line names the code that does it and the test that checks it. A change that weakens one should say so in its pull request.

### Repository, PR and model text is rendered inert

- [x] **The page loads nothing.** `review.html` is one file: the viewer's script, styles and notices are inline, and its Content-Security-Policy is `default-src 'none'` with the script allowed by its SHA-256 only. No CDN, analytics or font request can expose the code, whatever a later change tries. `vite.config.ts`; `src/renderer/render.test.ts`, `src/viewer/App.test.tsx` (no `fetch` or XHR).
- [x] **Data can't leave its element.** The three documents sit in `<script type="application/json">` elements, and `scriptJson()` escapes every `<`, U+2028 and U+2029, so no text can close the element, open a comment or start a tag. `src/renderer/embed.ts`; `embed.test.ts`, `render.test.ts`.
- [x] **The viewer renders text, never HTML.** Repository and model text is only React text. ESLint makes `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` and `createContextualFragment` errors in viewer code. `eslint.config.js`; `src/viewer/App.test.tsx`, `Diff.test.tsx`.
- [x] **Bidirectional controls and invisible characters can't disguise code** (Trojan Source, CVE-2021-42574). In a diff each one (a bidi control, a zero-width space or joiner, a byte order mark, a Hangul filler, a tag character, a run of variation selectors…) is isolated in its own span (`unicode-bidi: isolate`) and shown by its code point, and the diff says how many it has. `src/viewer/diff.ts`, `src/viewer/Diff.tsx`; `src/viewer/Diff.test.tsx`, `src/viewer/Security.test.tsx`.
- [x] **File names can't forge text or send escapes.** In summary.txt and the terminal, `planner-input.md`, the candidate batches, `show` and "Copy feedback for agent", a path or name with a control character or a bidi control is quoted as Git's `core.quotePath` does (`quotePath()`). Code is fenced so that no backtick run inside it closes the fence (`fence()`). `src/text/index.ts`, `src/planner/input.ts`; `src/text/index.test.ts`, `src/cli/security.test.ts`.
- [x] **Model text is data, not instructions.** The plan is validated against a strict schema: no unknown fields, so no code text, no new code edges, no `verified` verdicts (`src/planner/validate.ts`). The renderer only embeds it. The planner input, the batches and SKILL.md tell the agent that repository text, PR text and exported feedback are untrusted data.
- [x] **The malicious-content fixture renders safely.** HTML and script in code, a file name and plan text; a Trojan Source line; file names with a newline and a terminal escape. `test/fixtures/malicious-content.ts`; `src/cli/security.test.ts` (the page is the viewer's, element for element, plus the data), `src/viewer/Security.test.tsx` (every view, no element or handler from the data).

### Paths stay inside the repository and snapshot

- [x] **Paths are repository-relative.** The contracts reject an absolute path or a `..` segment (`RepoPath`), and `show --file` checks its argument the same way. `src/schemas/common.ts`, `src/cli/main.ts`.
- [x] **Files are read from Git, not the file system,** for the snapshot and for unchanged files (`<rev>:<path>` through `git cat-file --batch`), so a path can only name something in the snapshot's tree. `src/analysis/semantic/snapshot-files.ts`; `snapshot-files.test.ts`.
- [x] **The language-server session joins paths inside its root only.** `#abs()` throws for a path that would land outside it, and a location a server returns outside the root is dropped (`isInside()`). `src/analysis/semantic/session.ts`, `servers.ts`; `servers.test.ts`, `session.test.ts`.
- [x] **Checkouts for language servers are Git's own.** `checkout-index` refuses paths Git considers unsafe, does not follow symlinks out of the directory, and writes into a new temporary directory. `src/git/checkout.ts`.
- [x] **The CLI writes only fixed names** (`changes.json`, `graph.json`, `plan.json`, `planner-input.md`, `candidates/batch-<n>.md`, `summary.txt`, `review.html`) in the review directory, and appends to `.git/info/exclude`. `src/cli/generate.ts`.

### Nothing from the repository runs without consent

- [x] **Git runs no drivers or hooks.** The diff passes `--no-ext-diff` and `--no-textconv`, and ignores the per-user and system attributes files. Every git call passes `core.hooksPath=<null device>`. A repository's `.gitattributes` can only name a driver; only Git config can define one. `src/git/extract.ts`, `src/git/run.ts`; `src/git/checkout.test.ts`, `src/cli/security.test.ts`.
- [x] **No package manager or build runs.** The CLI never runs npm, a build or a test. Language servers that run project code while indexing (jdtls with Gradle or Maven, rust-analyzer) start only with `--allow-project-code`. `src/analysis/semantic/servers.ts`.
- [x] **The project's own tools are used only when they are the user's.** Without the opt-in, a `node_modules` that Git tracks or that links into the repository is passed over, as are an in-repository virtualenv and relative or in-repository `PATH` entries. `src/analysis/semantic/README.md` ("Security"); `servers.test.ts`, `src/cli/security.test.ts`.
- [x] **No executable is looked up in the repository on Windows.** Node looks a bare command up in the working directory first there, so git and gh are found on `PATH`'s absolute entries (`resolveExecutable()`), and `render --open` runs `%SystemRoot%\explorer.exe`. `src/git/run.ts`, `src/cli/open.ts`; `src/git/run.test.ts`.
- [x] **The language-server commands are listed.** `src/analysis/semantic/README.md` gives the exact command line for each server.

### Resources are capped

| Cap | Value | Past it | Where |
|---|---|---|---|
| Content per file, each side | 1 MiB (`MAX_CONTENT_BYTES`) | Stored without content (`too-large`), hunks kept | `src/git/extract.ts` |
| Content of the whole change, both sides | 64 MiB (`MAX_TOTAL_CONTENT_BYTES`) | The files after it, in diff order, are stored as `too-large`, hunks kept | `src/git/extract.ts` |
| Diff output | 64 MiB (`MAX_DIFF_BYTES`) | The run fails, saying to review a smaller change | `src/git/extract.ts` |
| Tree-sitter parse | 1 MiB per file (`MAX_PARSE_BYTES`) | Not parsed; a file node | `src/analysis/structural/analyze.ts` |
| Unchanged file read for import resolution, file read for a server's answer | 1 MiB | Counts as unreadable | `snapshot-files.ts`, `session.ts` |
| One language-server message | 64 MiB (`MAX_MESSAGE_BYTES`) | The connection closes; the language reports the failure | `src/analysis/semantic/jsonrpc.ts` |
| Callers or references shown per changed entity | 100 (`MAX_CANDIDATES_PER_ENTITY`) | "Showing N of M" | `src/analysis/semantic/analyze.ts` |
| Files searched for other definitions of a name | 200 (`MAX_DEFINITION_FILES`) | Not counted | `src/analysis/semantic/analyze.ts` |
| Re-export hops followed; ancestors followed | 3 (`MAX_REEXPORT_DEPTH`); 32 | Stops there | `imports.ts`, `session.ts` |
| Language-server requests | Per-request and readiness timeouts | Reported as unknown, not as "no references" | `src/analysis/semantic/session.ts` |
| Model input | Token budget (24,000), lines per hunk, edges judged (`MAX_ADJUDICATED_EDGES`, 1,000) | Hunks withheld or truncated, with `show` to fetch them | `src/planner/` |
| Rename and copy detection | Git's rename limit, 1,000 | Detection narrowed, with a warning | `src/git/extract.ts` |

The 64 MiB caps stop a hostile or accidental change from exhausting memory: Node holds about 512 MiB in one string, and `changes.json` and `review.html` each hold the content and the patches. They are not performance budgets; #36 sets those.

### Privacy

- [x] **Local first.** The CLI makes no network request except for a `--pr` target (`gh`, and `git fetch` of the pull request's commits), has no telemetry, and needs no hosted service.
- [x] **What reaches the model is said.** SKILL.md tells the user what runs locally and what the agent reads (design reference §14.3).
- [x] **Likely secrets stay out of model input.** `.env` files and keys are withheld, and high-confidence tokens are redacted in `planner-input.md`, the batches and `show` output. This is best effort. `src/planner/secrets.ts`; `secrets.test.ts`.
- [x] **The page says it holds the code.** `review.html` contains the full text of every changed file, and its outline says so: share it only where that code may go.

## Known gaps

- `review.html` is as sensitive as the code it reviews, and its secrets are not redacted: only the model input is.
- Git config the user set still applies to their own repository: clean and smudge filters (Git LFS skips downloads), `core.fsmonitor`, `core.autocrlf`. These are the user's tools, not the change's.
- A repository's `pyrightconfig.json` chooses what pyright reads (stubs, extra paths), so a change can hide references from it. That affects accuracy, not execution (`src/analysis/semantic/README.md`).
- On Windows, servers get `NoDefaultCurrentDirectoryInExePath=1`; whether every server's own process library honours it is not verified.
- Bidirectional controls and invisible characters are marked in code, but not in file names or group titles in the viewer, and `quotePath()` quotes bidi controls in a path but not invisible characters.
- The 64 MiB total content cap labels a binary file whose type Git didn't print (a mode-only change) as `too-large` rather than `binary` when it is past the cap.
