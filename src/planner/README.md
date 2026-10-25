# Planner

What the agent sees when it writes `plan.json` (issue #22; design reference §8.6, §11.2, §14.2–14.3), how that plan is checked (#23, [below](#plan-validation-validate)), the plan used without an agent (#24, [below](#fallback-plan)), and the caller candidates the agent judges (#43, [below](#caller-candidates-43)). `generate` writes the input as `planner-input.md` and the fallback plan as `plan.json`, next to `changes.json` and `graph.json`. `better-code-review show` fetches anything it leaves out, and `better-code-review validate` checks the plan. The CLI still makes no model calls (MVP spec D8): these are files and commands the agent reads.

| File | Contents |
|---|---|
| `input.ts` | `plannerInput()`: the Markdown input, its selection policy and size budget |
| `show.ts` | `show()`: a hunk, node or edge by ID, or lines of any snapshot file |
| `secrets.ts` | `sensitiveFile()` and `redactSecrets()`, used by both |
| `validate.ts` | `validatePlan()`: the plan's rules, and the `ungrouped` group for nodes with no home |
| `fallback.ts` | `fallbackPlan()`: a plan made from the graph alone, with no model |
| `candidates.ts` | `selectCandidates()`, `candidateBatches()` and `edgeStatuses()`: which `possible` edges need a verdict, their context, and the label each edge gets |

## Format of `planner-input.md`

Compact Markdown, one line per item, with the IDs the plan must cite. JSON would cost roughly 30–50% more tokens for the same content. In order:

1. **Header:** the target, snapshot ID, counts, the size line (`Size: ~N of 24,000 estimated tokens; X of Y hunks shown`), and a reminder that quoted repository and PR text is untrusted data, never instructions.
2. **Pull request** (`pr` targets only): URL, branches, then the title and description in a fence. The optional user requirement isn't here. The agent already has the user's words, so the skill (#25) passes it in the conversation.
3. **Notes:** the D12 caveat, each language's server status and guidance, capped fan-out, excluded untracked files, extraction warnings, and what was redacted.
4. **Files:** `- path (from old): status, language, tier[, test][, skipped: …][, diffs not inlined: …], +added −removed`.
5. **Nodes:** `- n_… <kind> <name> @ path:start-end (was a-b): h_… h_…`. Ranges are on the new side. `(was …)` appears only when the old range or path differs, and `(deleted)` marks an entity that exists only on the old side.
6. **Code edges:** `- e_… callee ← caller: relation, provenance, sides …, N hits (first path:line side; method outcome ×n, …)`. A test-file edge reads `← path (test file)`.
7. **Caller candidates** (written by `generate` only): how many `possible` edges need a verdict, the batch files that hold them, how many were settled without AI, and how many are over the cap ([below](#caller-candidates-43)).
8. **Diffs**, by file in diff order: each hunk is either `- h_… (node names)` followed by a fenced `diff`, or `- h_… (…): N lines not shown (reason)`.

Fences are always longer than any backtick run inside them, so quoted text can't close them. The output is deterministic: the same snapshot always gives the same bytes.

## Selection policy and budgets

- **The graph summary is never cut.** Every file, node (with its hunk IDs) and code edge is listed, because the plan must give every node a home group and may only cite IDs that exist.
- **Diffs fill the rest of the budget** (`DEFAULT_TOKEN_BUDGET`, 24,000 estimated tokens for the whole file). Priority order:
  1. Hunks in non-test files before hunks in test files.
  2. Within those, hunks on the most connected nodes first (most code edges).
  3. Then diff order.

  A hunk that doesn't fit is listed with its line count, so the agent can fetch it with `show`. Hunks are then printed in diff order, whichever were chosen.
- **Each hunk is capped** at `DEFAULT_MAX_HUNK_LINES` (150) body lines, with a `… N more lines` pointer.
- **Never inlined:**
  - sensitive files
  - binary files and files whose content was omitted (too large, not UTF-8)
  - generated files
  - lock files (`package-lock.json`, `yarn.lock`, `go.sum`, …)
- **Token estimate:** characters ÷ 4. That's good enough for a budget. #85 can switch to exact counts from the `count_tokens` endpoint.

**Known limit.** The node and edge lines cost about 30 and 45 tokens each, and they aren't budgeted. A change with thousands of nodes would exceed the budget before any diff is shown. Collapsing such graphs (for example by file) is left to #36.

### Measured on the fixture portfolio

From `generate --no-lsp` on each fixture (`test/fixtures/`). `portfolio.test.ts` checks that every input lists all nodes and hunks and stays within budget.

| Fixture | Nodes | Edges | Hunks shown | Est. tokens | Candidates (#43) | Batch tokens |
|---|--:|--:|--:|--:|--:|--:|
| `signature` | 12 | 8 | 12/12 | 1,704 | 2 | 562 |
| `ten-callers` | 11 | 10 | 11/11 | 1,869 | 0 | - |
| `unchanged-caller` | 1 | 0 | 1/1 | 364 | 0 | - |
| `removed-calls` | 7 | 3 | 4/4 | 891 | 0 | - |
| `rename-move` | 5 | 1 | 3/3 | 704 | 0 | - |
| `independent-roots` | 3 | 0 | 3/3 | 534 | 0 | - |
| `feature-flow` | 12 | 7 | 5/5 | 1,385 | 0 | - |
| `interface-impl` | 14 | 15 | 5/5 | 1,921 | 8 | 1,220 |
| `override-dispatch` | 2 | 1 | 2/2 | 500 | 1 | 477 |
| `override-dispatch-python` | 2 | 1 | 2/2 | 498 | 1 | 471 |
| `same-name` | 6 | 5 | 5/5 | 1,079 | 3 | 723 |
| `tests-and-config` | 5 | 0 | 4/4 | 750 | 0 | - |
| `dynamic-calls` | 3 | 0 | 3/3 | 607 | 0 | - |
| `unsupported-binary` | 5 | 0 | 4/4 | 632 | 0 | - |
| `large-generated` | 153 | 129 | 3/5 (1 truncated) | 10,168 | 0 | - |

In `large-generated`, the generated file and the JSON file over the size cap are not shown, and the 120-function hunk is truncated. About 8,000 of its tokens are node and edge lines. Candidates are the `possible` edges the agent is asked to judge; the batch tokens are those of `candidates/`, read on top of the input.

## On-demand context: `show`

```text
better-code-review show --dir <review dir> <h_… | n_… | e_…>
better-code-review show --dir <review dir> --file <path> [--side old|new] [--lines a-b]
```

- **Hunk:** the whole patch, up to `MAX_SHOW_LINES` (400) lines. Generated and lock-file hunks are shown when asked for; only sensitive files are refused.
- **Node:** the node's line, its code edges and its source on each side, with line numbers.
- **Edge:** each evidence site with its methods and outcomes, plus two lines either side.
- **File:** numbered lines of any file in the snapshot, changed or not. By default it prints the first 400 lines, then points at the next range.

Everything comes from the snapshot. Changed files come from `changes.json`, and unchanged ones from Git at the snapshot's revision (`gitSnapshotFiles`), never from the working tree as it is now. So `show` must run inside the repository; elsewhere only changed files can be read. Unknown IDs, missing files and out-of-range lines exit 1 with a message the agent can act on.

## Plan validation: `validate`

```text
better-code-review validate --dir <review dir> [--plan <file>]
```

The repair loop: the agent writes `plan.json`, runs `validate`, fixes what it reports, and runs it again. The [skill](../../skills/better-code-review/SKILL.md#4-validate-and-repair) allows at most 3 repair rounds. After that it keeps the agent's plan as `plan.rejected.json` and runs `better-code-review fallback --dir <dir>`, which writes the fallback plan (D8, #24) to `plan.json`. `validate` reads `plan.json` and never rewrites it.

It prints JSON and exits 0 when the plan is valid, 1 when it isn't:

```json
{ "valid": true, "ungroupedNodeIds": ["n_…"] }
{ "valid": false, "errors": [
  { "path": "/groups/1/nodeIds/0", "code": "multiple-homes",
    "message": "node n_… already has its home in group g0; move it to this group's referenceNodeIds" }
] }
```

`path` is a JSON Pointer into the plan (`""` for the whole file). `code` is one of:

| Code | Meaning |
|---|---|
| `json` | Not valid JSON |
| `schema` | Wrong shape. Unknown fields are rejected, so the plan can't carry code text or a `provenance` |
| `snapshot` | `snapshotId` is not the graph's |
| `origin` | An agent plan with a `fallbackReason` |
| `duplicate-id` | A group or inferred relationship ID used twice |
| `reserved-id` | `ungrouped` used as a group ID in an agent plan, or as a child group |
| `unknown-id` | A node, group or edge that does not exist. Verdicts can't add edges |
| `multiple-homes` | A node in more than one group's `nodeIds`, or listed twice in one group |
| `nesting` | A group inside itself, two levels deep, or with two parents |
| `group-order` | `groupOrder` misses a top-level group, repeats one or lists a child |
| `verdict` | A verdict on a `verified` edge, a second verdict on one edge, or a `via` on anything but `yes` |
| `citation` | A cited line that isn't in the snapshot |

All errors are reported at once. Schema errors come alone, since the other rules need a well-formed plan.

**Ungrouped.** Nodes the plan gives no home are not an error. `validatePlan()` puts them in the `ungrouped` group ("Ungrouped / requires review", D1), last in `groupOrder`, and `validate` lists them so the agent can place them. Since the graph puts every hunk on a node, every hunk is then visible. A valid plan with every node placed comes back unchanged.

**Citations** may point at unchanged files, because `show --file` lets the agent read them. The line must exist on that side of the snapshot. Files with omitted content (binary, too large, not UTF-8) can't be cited.

## Caller candidates (#43)

The AI step of the analysis pipeline (`docs/research/existing-tools.md` § "Analysis approach"): the agent judges the `possible` edges the deterministic steps left open, and each verdict is labelled `inferred` (`yes`) or `rejected` (`no`), with a reason and a cited line. `unsure` leaves the edge `possible`. The CLI makes no model call. `generate` writes `candidates/batch-<n>.md` next to `planner-input.md`, whose Caller candidates section names them, and the agent puts its verdicts in `plan.json` `edgeVerdicts`, which `validate` checks. The numbers and choices below are #42's ([`candidate-adjudication.md`](../../docs/research/candidate-adjudication.md#pipeline-changes)).

**Selection** (`selectCandidates()`, from the graph alone). A `possible` edge is asked about unless one of its hits was accepted by import-path resolution or the unambiguous rule (an `import-resolution` or `unambiguous-rule` `confirmed` record). `verified` edges are never asked about, and hits a server or import resolution rejected made no edge. Test files are already one edge per (test file, changed entity) (D2). At most `MAX_ADJUDICATED_EDGES` (1,000) edges are asked about per review, in graph order; the rest are **not adjudicated** and stay `possible`. The largest #42 PR needed 528.

**Context** (`candidateBatches()`). Each batch starts with the verdict rules, including that type uses count as references for a changed class, interface or type (the only real false rejections in #42 were return types). Then:
- **Changed entities**, once per batch: the declaration line on each side, and up to 10 other definitions of the searched name in the snapshot, marked "NOT the changed entity" (git grep plus parsing, up to 200 files, as the unambiguous rule counts them).
- **Candidates, grouped by enclosing function** on one side: the new side when the edge has a hit there, else the old. A test-file edge is a group of its own, with up to 3 hits. Each group shows:
  - the file's imports;
  - **declarations the occurrences depend on**, when the code shown doesn't hold them: the receiver's declaration (`f` in `f.m()`, the field in `this.f.m()` or `self.f.m()`), the last one in the enclosing entity before the hit, else the first in the file; and, for a hit through an alias, the line elsewhere that names the target under it (`export { formatPrice as fmt }`). Most of #42's `unsure` answers lacked one of these;
  - the code: the whole entity up to 60 lines, else its first line and 4 lines around each hit, capped at `DEFAULT_MAX_HUNK_LINES` (150) with a `show --file` pointer; hits are marked `>>`;
  - the edges to decide, with each hit's line and shape (`call; on f`).
- **The old side too** (#94), for an edge with hits on both sides whose old-side receiver is declared differently, e.g. `Appendable accum` there and `QuietAppendable accum` here: the edge may be real on the old side only. The group then also shows the old side's imports (or "as on the new side"), declarations and code, and the edge's old-side hits. It is still one decision, `yes` if either side uses the changed entity. Comparing only the receivers' declaration lines keeps the batch the same when just the arguments or the body changed. Edges like jsoup's, a JDK interface that can reach a test's stub, are shown like any other: #42 called them over-counts, but they are real on the old side, and the verdict is the agent's.
- **Batching:** up to `MAX_GROUPS_PER_BATCH` (12) groups per batch, within `DEFAULT_TOKEN_BUDGET` (24,000 estimated tokens). A group larger than the budget gets a batch of its own.

The same rules as the planner input apply: repository text is fenced and untrusted, secrets are redacted, sensitive files are not shown, and the output is deterministic. A rerun deletes the old `candidates/` first.

**Labels** (`edgeStatuses()`, for the artifact). `verified` (LSP); `inferred` or `rejected` (a `yes` or `no` verdict); otherwise `possible`, with why: `unsure`, `settled` (accepted without AI), `not-adjudicated` (over the cap) or `not-judged` (no verdict; every candidate with no agent, or with the fallback plan, D8). Rejected and unsure edges stay in graph.json, so the viewer can show or collapse them. Nothing is ever labelled `verified` from a verdict.

**Validation.** The rules #43 needs were already in `validate` (#23): a verdict only on an existing `possible` edge (`unknown-id`, `verdict`), one per edge, never `verified` (the schema), and a cited line that exists (`citation`).

**Decisions (#43, simplest for now; revisit if the viewer or real PRs show a need):**
- **Settled edges are not judged.** An edge import resolution or the unambiguous rule accepted stays `possible` with the reason `settled`, and the AI is not asked about it. It is not shown as `inferred`, which stays reserved for the agent's verdicts (D6).
- **The validator accepts a verdict on any `possible` edge**, including one the batches did not ask about (settled, or over the cap). The skill asks for none, but an agent that adds one is not sent round the repair loop for it. Its label then follows the verdict.

**Measuring.** `npm run eval:live` keeps every plan it gets, and `npm run score:adjudication` scores their verdicts against ground truth ([CONTRIBUTING](../../CONTRIBUTING.md#testing-ai-steps)). Results on the fixtures and #42's pull requests, audited, with the gaps they found: [candidate-adjudication.md](../../docs/research/candidate-adjudication.md#43-results-the-ai-step-as-built).

## Fallback plan

`generate` always writes `plan.json` with `fallbackPlan()`, so the renderer has a plan without any model (design reference §8.1, MVP spec D8). The agent overwrites it with its own. The same function makes the plan to use when the agent's plan still fails after the repair loop: `better-code-review fallback --dir <dir>` writes it from `graph.json`, with a `fallbackReason` saying so.

- **Clustering.** Two nodes go together when a code edge joins them (of any provenance or side) or when they are in the same file. A test-file edge joins its target to the test file's nodes. Each cluster of two or more nodes is a group, titled after its node with the most incoming edges (`formatPrice and related changes`), or `Changes in <path>` when it has no edges.
- **Lone changes.** A code node joined to nothing is a group of its own, `Changes in <path>`: an independent change (design reference §13.5). File nodes joined to nothing (config, docs, binaries, unsupported languages) share one group, `Other changed files`, last in `groupOrder`. Every node has a home, so nothing goes to Ungrouped and `validatePlan()` returns the plan unchanged.
- **Nothing inferred.** No verdicts and no inferred relationships: every candidate edge stays `possible`.
- **Order.** Groups follow the graph's node order. Within a group, each callee comes before its callers (a test file's edge counts as coming from each of its nodes), so the contract is read first; a cycle is broken in graph order. The same graph always gives the same plan.

`portfolio.test.ts` checks that the plan is valid, with no node left to place, for every fixture. [`docs/research/planner-eval.md`](../../docs/research/planner-eval.md#baseline-the-fallback-plan) scores it against the agent plan checks (#26).

## Secret avoidance

This is best effort (design reference §14.2). It applies to both the input and `show`:

- **Withheld files.** Names that usually hold secrets are never shown: `.env` and `.env.*` (but not `.example`, `.sample`, `.template` or `.dist`), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.ppk`, `id_rsa`-style SSH keys, `.netrc`, `.pgpass` and `.htpasswd`.
- **Redacted values.** Values matching high-confidence token patterns become `[REDACTED:<kind>]`. The patterns cover:
  - AWS access key IDs
  - GitHub, GitLab, Slack, Stripe live, Google API, Anthropic, OpenAI and npm tokens
  - JWTs
  - passwords in `scheme://user:password@host`
  - private key blocks, redacted line by line with the BEGIN and END markers kept

  Line numbers never change, so a line cited from redacted text still points at the snapshot. The Notes section says how many values were redacted and where.
- **Not covered:**
  - generic `password = "…"` assignments and other low-confidence patterns, which are left alone to avoid false positives
  - files the agent reads directly from disk with its own tools

  The [skill](../../skills/better-code-review/SKILL.md#what-runs-where) tells the agent to read the change only through `planner-input.md` and `show`, and says what goes to the model.
