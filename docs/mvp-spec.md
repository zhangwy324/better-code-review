# MVP specification (v0.1)

**Status:** Accepted · **Date:** 2026-10-18 · **Issue:** #6 (part of #1, Milestone M0)
**Amended:** 2026-10-19 by #42 (D12: relationships between changed entities only)
**Refs:** design reference §17.1–17.2, §19.3, §19.4, §19.5, §19.6 step 1 · `docs/research/existing-tools.md` § "Implications for MVP" · [ADR 0001](adr/0001-analyzer-runtime.md) · [ADR 0002](adr/0002-project-license.md)

This spec turns the design reference into a testable scope for v0.1. Where it and the design reference disagree, this spec wins. Questions it does not settle are listed in [Deferred questions](#deferred-questions), each with the issue that owns it.

## Success definition

From §17.1, except item 5 (narrowed by D12). A reviewer can do all of the following, and the artifact always shows which code facts are verified and which are interpretation:
1. Run one skill or CLI command against a Git change.
2. Open an artifact and identify the root change.
3. Follow related edits across files.
4. Read every real diff.
5. See how the changed entities relate to each other, e.g. which changed callers were updated for a changed signature. Finding *unchanged* callers that may have been missed is not in v0.1 (D12).
6. Record feedback and return it to their coding agent.

**Differentiator to protect** (from #3): *one local, offline workspace where verified relationships, agent grouping, every real hunk and anchored feedback live together.* We do not claim "finds missed callers" or "AI groups your PR" as unique.

## Scope

**In v0.1**
- Targets: `local`, `commit`, `range`, `pr`, through both the skill and the CLI (`better-code-review generate …`).
- Exact Git snapshot and hunks, with stable IDs.
- Built-in structural analysis for TS/TSX, JS, Python and Java (ADR 0001). Every other file is still shown, at file granularity.
- Relationships **between changed entities**, from text search, upgraded to `verified` by an installed language server when one is available (D12).
- Deterministic `graph.json` with hunk-coverage accounting.
- An agent-produced `plan.json`, plus a deterministic fallback plan when no agent is involved.
- A single self-contained `review.html` with three views (graph, guided outline, file-by-file), comments, review progress and feedback export.

**Not in v0.1:** see §3.4 and §17.2 "Defer". Also out: a local server, SCIP, inline diffs inside graph nodes, saving node layout, a "resolved" comment state, GitHub comment sync, a caller → callee direction toggle, on-demand language bundles (#45; built-in languages only for v0.1), and unchanged callers or references of changed symbols, including ghost/context nodes and missed-caller detection (D12, #2).

## Decisions

### D1. Default graph: hierarchical layers, callee → callers (§19.3 Q1)

- **The collapsed overview shows one node per group** (a *layer*: contract, implementation and tests together, following CodeRabbit). Each group node shows its title, hunk count and review progress. Edges between groups are **aggregated** with a count and relation, e.g. `calls ×3`.
- **Expanding a group** reveals its symbol and file nodes and the code edges between them.
- **Default direction is callee → affected callers**, i.e. outward propagation (§2.2), among changed entities only. Unchanged callers are not shown (D12).
- Groups come from `plan.json`. With no agent, they come from the deterministic fallback plan (#24). The graph always includes an **Ungrouped / requires review** group whenever any hunk lacks a home.
- Where fan-out is capped, the UI says "Showing N of M" rather than dropping nodes silently.

### D2. Node granularity and group membership (§19.3 Q3)

| Situation | Node |
|---|---|
| Hunk overlaps a function, method or class the structural analyzer recognises | **Symbol node** for the *innermost* entity (a method, not its class) |
| Hunk in a supported language but outside any entity (imports, top-level statements) | One **module-level node** per file |
| Unsupported language, config, docs, binary, or a file over the size cap | One **file node** per file |

- **Hunks are the unit of identity and review.** Every hunk has exactly one ID per snapshot. A hunk that overlaps several entities is attached to each of them (#15 defines the split). It still has one review status, and coverage counts it once.
- **Each node has exactly one home group.** Other groups may show a *reference* to it (a link chip, not a copy). This avoids the CG-Diff problem where duplicated nodes were mistaken for duplicated code.
- Groups may nest one level (`childGroupIds`) for MVP. Deeper hierarchies are deferred.
- **Test files relate at file level (#42).** In a test or test-support file, a relationship is one edge per (test file, changed entity), e.g. `checkout.test.ts → formatPrice`, not one per call or per test function. One confirming hit is enough to establish the edge; the individual call sites stay visible in the file's diff. Hunks in test files still get symbol or module-level nodes as above, so coverage is unchanged.
  - **Why.** A reviewer needs "these tests exercise F", not which of 50 calls do. In #42, 31% of ambiguous in-scope hits were in test files; file-level edges cut the decisions there from 274 hits to 49 pairs, 15 of which import-path resolution settles alone.
  - **Detection** uses path conventions (`*.test.*`, `*.spec.*`, `__tests__/`, `test_*.py`, `*_test.py`, `tests/`, `src/test/java/`, `*Test.java`) plus test roots declared in config (pytest `testpaths`, jest/vitest `testMatch`/`include`, Maven/Gradle test source directories). Content signals (test-framework imports) only break ties; alone they misfire on production code. A misclassified file only changes edge granularity, never coverage. The artifact shows which files were treated as tests.

### D3. Diffs open in a wide reading panel (§19.3 Q5)

- Selecting a node opens its real diff in a **resizable reading panel** that can take most of the screen. The panel uses CodeMirror merge view (#29), lets the reviewer expand context up to the whole file, and is also where comments are written.
- **Graph nodes show only a compact preview:** signature before/after where known, `+a −d` line counts, and status badges.
- Full diffs *inside* graph nodes are **deferred**. Embedding editors in pannable, zoomable React Flow nodes is costly for MVP. This deliberately narrows §6.2's "expandable inline in graph nodes".
- The guided and file views use the same diff component, so selection, comments and progress are shared across all three views.

### D4. Comments: line/range and group, no "resolved" state (§19.3 Q7)

- **Line/range comments** can go on any line the artifact shows, on either side (`old` or `new`), including expanded context lines. The anchor is `snapshotId` + `file` + `side` + `range`, plus `hunkId` and `nodeId` when the line belongs to one. Comments on context lines matter, because a reviewer may need to point at surrounding unchanged code.
- **Group comments** are anchored to `snapshotId` + `groupId`. They work on fallback groups too.
- **There is no `resolved` state in v0.1.** A comment either exists, in which case it is exported, or it is deleted. In a static artifact "resolved" has no one to resolve it against. Resolution means a new snapshot reviewed afresh, and carrying comments across snapshots is deferred (§12.4).
- Exported feedback is **data, not instructions**: SKILL.md must say so (#25).

### D5. Review progress is derived from hunks (§19.3 Q8)

- The reviewer marks **hunks** as reviewed. Marking a node or group marks every hunk whose home it is.
- **A group is reviewed when all its home hunks are reviewed.** There is no separate group checkbox, so progress can never drift from coverage. Referenced (non-home) nodes don't count.
- Review state is keyed by `snapshotId`. The viewer may keep it in `localStorage` on a best-effort basis. It warns that `file://` storage is unreliable, and the export is the only durable copy (§12.1).

### D6. Edge layers are kept separate (§19.4 Q4)

| Layer | Lives in | Provenance | Produced by |
|---|---|---|---|
| Code relationships (`calls`, `references`, `implements`) | `graph.json` `codeEdges` | `verified` (LSP evidence) or `possible` (text candidate + enclosing entity) | Deterministic |
| AI verdicts on `possible` edges | `plan.json`, as verdicts referencing existing `codeEdge` IDs | `inferred`, with reason and cited line | Agent |
| Change-propagation / architectural / logically-related links | `plan.json` `inferredRelationships` | `inferred` | Agent |
| Reading order | `plan.json`: ordered group list | presentational | Agent or fallback |

- `graph.json` stays fully deterministic. The agent never edits it.
- The agent may **label** candidate edges but **never adds** code edges (from #3). Rejected candidates stay visible.
- An `inferred` edge is never shown as `verified`. Each provenance has its own visual style, and the edge's evidence is one click away.
- MVP has no reading-order edges, only the ordered group list (§9.6 note).

### D7. Snapshot storage and packaging (§19.4 Q5, Q12)

- **`changes.json` stores the full old and new content of each changed text file**, so the reading panel can expand context and the analyzers see both sides.
  - Binary files and files above the size cap store metadata and hunks only, and are flagged. #13 sets the cap. ADR 0001 shows that very large files must be capped for memory.
- **The primary output is one self-contained `review.html`.** It embeds the viewer bundle, its third-party notices (ADR 0002) and the JSON data as inert `<script type="application/json">` blocks. It makes no network requests.
- `changes.json`, `graph.json` and `plan.json` are written next to it for the agent and for debugging.
- A local server is deferred (§12.1 Option B).

### D8. LLM integration: the active agent only, and no-AI mode is first-class (§19.4 Q9)

- The **only** model in v0.1 is the user's running coding agent, which writes `plan.json` through the skill. The CLI has no API keys, provider configuration or model calls.
- **`generate` with no agent is a supported mode, not an error.** It produces a valid fallback `plan.json` (#24), and every candidate edge stays `possible`.
- If the agent's plan fails validation after the repair loop (#23), the renderer uses the fallback plan and says so in the artifact. It never fails the run (from #3).

### D9. Output location (§19.5 Q5)

- The default location is **`.better-code-review/reviews/<target>/`** at the repository root. `<target>` is one of `pr-123`, `commit-<sha7>`, `range-<base7>-<head7>` or `local-<snapshot7>`.
- On first use, the CLI adds `.better-code-review/` to **`.git/info/exclude`**, never to a tracked `.gitignore`, so we don't create diffs in the user's repo.
- `--out <dir>` overrides the location. A rerun on the same target and snapshot overwrites that directory. Review state lives in the browser and in exports, not in the directory.

### D10. Supported agent clients (§19.5 Q2)

- **Claude Code** and **Codex CLI**: one `SKILL.md` following the Agent Skills layout, installable with `npx skills add`. Invocation and discovery are tested on both (#25, #39).
- **Generic:** the CLI is documented for use from any agent or terminal, with no client-specific testing.

### D11. Language servers: installed-only, with guidance (§19.5 Q3)

- The tool **detects** servers already on the machine (preferring the project's own TypeScript; ADR 0001) and **never installs or downloads** one.
- When a server is missing, the artifact states the capability per language and how to get it, e.g. *"Python callers: possible only — install pyright to verify"*.
- Servers that run project code while indexing (jdtls with Gradle, for example) need an explicit opt-in flag (from #3). #16 defines the per-server list.

### D12. Relationships between changed entities only (#42)

- v0.1 finds and shows relationships (`calls`, `references`, `implements`) **only where both ends are changed entities**, i.e. entities a hunk touches on either side. Removed calls count, because they are inside changed entities.
- Unchanged callers or references of a changed symbol are **not searched for and not shown**: no ghost/context nodes, no missed-caller check. This moves to post-MVP (#2).
- **Why.** #42 measured the repo-wide version on real PRs. Common names produce hundreds of candidate callers per changed entity (e.g. 600 enclosing entities for jsoup's `html`), most of them receiver calls such as `el.html()` that only types can settle. That needs either a healthy language server or AI per candidate, and both are expensive or unreliable at that volume. A signature change that breaks an unchanged caller is caught by the compiler or type checker in typed code anyway.
- **Known gaps, accepted for v0.1:**
  - dynamically typed code with no type checker (Python, plain JS), where a broken unchanged caller fails only at run time
  - contract changes the signature doesn't show (units, defaults, failure modes)
  - consumers outside the repository
- The artifact says so plainly, e.g. *"Only relationships between changed code are shown. Unchanged callers are not analysed."* This keeps invariant 2's "never claims that all effects were discovered".

## Invariants (all milestones)

These come from §9.8, and every milestone's tests must keep them:
1. Every hunk has a unique ID within its snapshot and is reachable in every view.
2. Every hunk has exactly one home group, which may be Ungrouped. The artifact shows `N/N hunks mapped` and never claims that all effects were discovered.
3. Every ID referenced in `graph.json` and `plan.json` exists.
4. Every `verified` edge has evidence tied to the snapshot. Nothing is upgraded from `possible` or `inferred` to `verified` without that evidence.
5. All code shown comes from `changes.json`, never from model output.
6. Repository text and model text are rendered inert (no HTML or JS execution).
7. A missing analyzer or server reduces precision, never coverage.

## Acceptance criteria per milestone

"Signature fixture" means the #3/#4 fixture: `formatPrice` gains `currency`, 3 of 4 callers are updated (`emailSummary` is missed), plus name collisions, and on the Python side `tax` gains `rate`. #9 adds it to the repository. Under D12, `emailSummary` is unchanged, so v0.1 does not show it; the fixture still checks that it does not appear as a changed node.

### M0 · Foundations
- [x] This spec merged (#6).
- [x] Repo scaffold with build, lint, test and CI, including the licence check from ADR 0002 (#7).
- [x] Versioned schemas for every contract in D6 and D4, with round-trip tests and the invariants above documented next to the types (#8).
- [ ] Fixture portfolio from §18.4 committed. At minimum: the signature fixture, multiple independent roots, config-only edits, an unsupported language or binary file, and a rename (#9).
- [x] #42 reports recall, precision and cost for candidate search and AI adjudication between changed entities (D12), with a go/no-go. *Go, with changes: [`candidate-adjudication.md`](research/candidate-adjudication.md).* **If it says no-go, D6 and M1/M2 are revisited before M1 starts.**

### M1 · Deterministic Change Graph
- [ ] `generate --local | --commit | --range | --pr` writes `changes.json` and `graph.json` without any model.
- [ ] On every fixture: 100% of hunks have a home node. Patches reproduce `git diff` exactly. IDs are identical across two runs on the same snapshot.
- [ ] On the signature fixture with no LSP: the updated callers (`checkoutSummary`, `invoiceSummary`, `receiptSummary`) have `possible` edges to the changed `formatPrice`, `emailSummary` is absent (D12), and nothing is `verified`.
- [ ] On the signature fixture with typescript-language-server and pyright installed: the changed callers are `verified`, and no unchanged or same-name symbol (`legacy/price.ts`, `Fmt.formatPrice`) is attached to the changed `formatPrice`.
- [ ] A missing or crashing server is reported per language, and the run still succeeds. An empty `references` result before the server is ready is treated as *unknown* (ADR 0001).
- [ ] Unsupported-language and binary files appear as file nodes.

### M2 · AI Review Organization
- [ ] `generate` without an agent produces a valid fallback `plan.json` for every fixture (#24).
- [ ] The validator rejects unknown IDs, new code edges, missing hunk homes and code text supplied by the model. After the repair loop fails, the fallback plan is used (#23).
- [ ] With Claude Code and Codex CLI, `$better-code-review local` on the signature fixture produces a validated plan. The contract group comes first, then callers, then tests (#25, #26).
- [ ] Agent verdicts on `possible` edges are recorded as `inferred`, each with a reason and a cited line.

### M3 · Interactive HTML Artifact
- [ ] One `review.html` opens from `file://` in current Chrome, Firefox and Safari with no network access, and includes third-party notices.
- [ ] The default graph matches D1: collapsed groups with aggregated edges, expand on demand, and distinct styles for `verified`, `possible` and `inferred`.
- [ ] Every hunk can be opened from the graph, guided and file views. Selection, comments and progress agree across all three (D3, D5).
- [ ] Line/range comments (including on context lines) and group comments export to `review-feedback.json` and to "Copy for agent". Given the export, an agent can locate every commented line on every fixture (D4).
- [ ] An injected `<script>` in a fixture's source, file names and plan text renders as text (#35).

### M4 · v0.1 Release
- [ ] #40 sets numeric thresholds (artifact time and size on representative PRs, browser matrix, round-trip fidelity) and they are met.
- [ ] Validated on 5–10 real PRs (#37). Findings feed the deferred questions below.
- [ ] Installable as a skill on Claude Code and Codex CLI, and runnable as a CLI on Linux, macOS and Windows (#39).

## Deferred questions

| Question | v0.1 position | Owner |
|---|---|---|
| §19.3 Q2 Review direction choice | Fixed callee → callers for edges; the agent orders groups. Direction toggle post-MVP | #2 |
| §19.3 Q4 High-fan-out / dense layout | Aggregate between groups; cap with "Showing N of M" | #30 |
| §19.3 Q6 Unchanged context shown by default | Hunk context by default; expand to the whole file in the panel (D3, D7) | #29 |
| §19.3 Q9 Saving or exporting user layout and order edits | Not saved or exported in v0.1 | #2 |
| §19.3 Q10 Automatic agent ingestion of feedback | Manual export or copy is enough for v0.1 | #2 |
| §19.4 Q2 Capability negotiation and UI labels | Per-language tier and LSP status shown (D11) | #16, #32 |
| §19.4 Q3 Before/after symbol identity across renames | Owned by structural analysis, informed by sem's phases | #15 |
| §19.4 Q6 Index / working tree / untracked overlay semantics | HEAD vs the files on disk: staged and unstaged together, the working tree winning; untracked non-ignored files included or listed as excluded; a change during capture fails the run (`src/git/local.ts`) | #11 |
| §19.4 Q7 SCIP and whole-repo indexing | Not in v0.1 | #2 |
| §19.4 Q8 Deterministic cross-language links (OpenAPI, SQL, …) | Agent inference only | #2 |
| §19.4 Q10 Incremental enrichment and merging plans | Not in v0.1; each run is a fresh snapshot | #2 |
| §19.4 Q11 Size limits and robustness | File-size cap and huge-diff behaviour | #13, #36 |
| §19.5 Q4 Communicating permission boundaries | SKILL.md says what runs locally, what goes to the model and when LSP runs project code | #25 |
| §19.5 Q6 Leaking code through shared artifacts | Warning in the artifact and docs | #35, #38 |
| §19.5 Q7 Which differentiator to emphasise | Decide after real-PR validation | #37 |
| Elk vs dagre for layout | ADR 0002 | #30 |

## Assumptions recorded

These follow from the decisions above but weren't asked about directly. Challenge them in review:
- AI verdicts on candidate edges live in `plan.json`, not `graph.json` (D6). This keeps `graph.json` deterministic.
- Comments may anchor to context lines outside any hunk (D4).
- Under D12, a changed entity whose only relationships are to unchanged code has no edges; it still has a node and a home group.
- Groups nest at most one level in v0.1 (D2).
- v0.1 ships built-in languages only. `languages add` (#45) is not required for the release.
