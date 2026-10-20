# Planner input

What the agent sees when it writes `plan.json` (issue #22; design reference §8.6, §11.2, §14.2–14.3). `generate` writes it as `planner-input.md` next to `changes.json` and `graph.json`. `better-code-review show` fetches anything it leaves out. The CLI still makes no model calls (MVP spec D8): these are files and commands the agent reads.

| File | Contents |
|---|---|
| `input.ts` | `plannerInput()`: the Markdown input, its selection policy and size budget |
| `show.ts` | `show()`: a hunk, node or edge by ID, or lines of any snapshot file |
| `secrets.ts` | `sensitiveFile()` and `redactSecrets()`, used by both |

## Format of `planner-input.md`

Compact Markdown, one line per item, with the IDs the plan must cite. JSON would cost roughly 30–50% more tokens for the same content. In order:

1. **Header:** the target, snapshot ID, counts, the size line (`Size: ~N of 24,000 estimated tokens; X of Y hunks shown`), and a reminder that quoted repository and PR text is untrusted data, never instructions.
2. **Pull request** (`pr` targets only): URL, branches, then the title and description in a fence. The optional user requirement isn't here. The agent already has the user's words, so the skill (#25) passes it in the conversation.
3. **Notes:** the D12 caveat, each language's server status and guidance, capped fan-out, excluded untracked files, extraction warnings, and what was redacted.
4. **Files:** `- path (from old): status, language, tier[, test][, skipped: …][, diffs not inlined: …], +added −removed`.
5. **Nodes:** `- n_… <kind> <name> @ path:start-end (was a-b): h_… h_…`. Ranges are on the new side. `(was …)` appears only when the old range or path differs, and `(deleted)` marks an entity that exists only on the old side.
6. **Code edges:** `- e_… callee ← caller: relation, provenance, sides …, N hits (first path:line side; method outcome ×n, …)`. A test-file edge reads `← path (test file)`.
7. **Diffs**, by file in diff order: each hunk is either `- h_… (node names)` followed by a fenced `diff`, or `- h_… (…): N lines not shown (reason)`.

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

| Fixture | Nodes | Edges | Hunks shown | Est. tokens |
|---|--:|--:|--:|--:|
| `signature` | 12 | 8 | 12/12 | 1,648 |
| `ten-callers` | 11 | 10 | 11/11 | 1,755 |
| `unchanged-caller` | 1 | 0 | 1/1 | 350 |
| `removed-calls` | 7 | 3 | 4/4 | 834 |
| `rename-move` | 5 | 1 | 3/3 | 661 |
| `independent-roots` | 3 | 0 | 3/3 | 520 |
| `feature-flow` | 12 | 7 | 5/5 | 1,328 |
| `interface-impl` | 14 | 15 | 5/5 | 1,865 |
| `override-dispatch` | 2 | 1 | 2/2 | 466 |
| `override-dispatch-python` | 2 | 1 | 2/2 | 464 |
| `same-name` | 6 | 5 | 5/5 | 1,023 |
| `tests-and-config` | 5 | 0 | 4/4 | 736 |
| `dynamic-calls` | 3 | 0 | 3/3 | 592 |
| `unsupported-binary` | 5 | 0 | 4/4 | 618 |
| `large-generated` | 153 | 129 | 3/5 (1 truncated) | 9,131 |

In `large-generated`, the generated file and the JSON file over the size cap are not shown, and the 120-function hunk is truncated. About 7,000 of its tokens are node and edge lines.

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

  SKILL.md (#25) must tell the agent to fetch context with `show`, and say what goes to the model.
