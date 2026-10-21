# Contributing

Thanks for your interest. The project is at an early stage (Milestone M0); the scope for v0.1 is in [`docs/mvp-spec.md`](docs/mvp-spec.md), and the background is in [`docs/better-code-review_design_reference.md`](docs/better-code-review_design_reference.md).

## Licence

The project is MIT-licensed. Contributions are accepted under the same licence ("inbound = outbound"); there is no CLA or DCO. See [ADR 0002](docs/adr/0002-project-license.md).

## Setup

You need **Node.js 24 or later** (the only runtime; see [ADR 0001](docs/adr/0001-analyzer-runtime.md)) and **Git 2.30 or later**. Git 2.40 or later reads `.gitattributes` from the reviewed commit rather than the working tree, and the tests expect it; the reasons for both versions are at the top of [`src/git/extract.ts`](src/git/extract.ts).

```bash
npm ci
npm run check   # format check, lint, typecheck, build, tests: the same steps CI runs
```

| Script | What it does |
|---|---|
| `npm run build` | Compiles `src/` to `dist/` with `tsc` |
| `npm run typecheck` | Type-checks `src/` and `scripts/` without emitting |
| `npm run lint` | ESLint with type-aware `typescript-eslint` rules |
| `npm run format` / `format:check` | Prettier (Markdown is excluded and formatted by hand) |
| `npm test` | Vitest, once. The language-server integration suites skip when no server is installed |
| `npm run test:lsp` | Installs pinned language servers from `test/lsp-servers/` and runs the integration suites against them; fails if a server is missing ([`src/analysis/semantic/README.md`](src/analysis/semantic/README.md#tests)) |
| `npm run schemas` | Regenerates the JSON Schema files in `schemas/` from `src/schemas/` |
| `npm run licenses` | Checks production dependency and vendored grammar licences and writes `THIRD_PARTY_NOTICES` |
| `npm run fixtures` | Lists the test fixture portfolio, or builds one fixture as a repository to try by hand ([`test/fixtures/README.md`](test/fixtures/README.md)) |
| `npm run eval` | Live, budget-capped runs of the AI steps. **Spends real AI usage**; never part of `check` or CI ([Testing AI steps](#testing-ai-steps)) |
| `npm run grammars` | Re-vendors the built-in tree-sitter grammars from their pins ([`src/analysis/structural/README.md`](src/analysis/structural/README.md)) |

## Layout

One package, one language (ADR 0001). Modules are folders under `src/`, created when their first code lands:

| Folder | Contents |
|---|---|
| `src/cli/` | Commands, options, orchestration. `main.ts` is the `better-code-review` binary |
| `src/git/` | Snapshot and diff normalisation |
| `src/analysis/` | Structural (tree-sitter) and semantic (LSP) analysis |
| `src/graph/` | Deterministic change graph builder |
| `src/planner/` | Planner model input, plan validation and fallback plan |
| `src/text/` | Counts, lists and tallies in the text written for people and agents |
| `src/schemas/` | Versioned data contracts; conventions and versioning policy in its [`README.md`](src/schemas/README.md) |
| `src/renderer/` | `review.html` bundling |
| `src/viewer/` | The React viewer |

- `skills/better-code-review/` is the Agent Skill (#25): `SKILL.md` and its `references/`. It drives the CLI and writes `plan.json`. `test/skill/` checks that the flags it names exist and that it explains every validator error code.
- `schemas/` holds the generated JSON Schema files. Don't edit them; change `src/schemas/` and run `npm run schemas`.
- Unit tests sit next to the code as `*.test.ts`. The fixture portfolio, Git changes that tests across milestones share, is in `test/fixtures/` ([`README.md`](test/fixtures/README.md)).
- Relative imports use the `.ts` extension; `tsc` rewrites them to `.js` on build.
- Files the compiled code reads at run time (grammars, query files) are copied to `dist/` by `scripts/copy-assets.ts` during `npm run build`; add new asset folders there.
- `scripts/` holds repository tooling. Scripts are TypeScript run directly by Node (`node scripts/x.ts`), so they may only use erasable syntax (no `enum`, no parameter properties).

## Testing AI steps

The CLI makes no model calls ([MVP spec D8](docs/mvp-spec.md)). `plan.json` and the caller verdicts are the boundary, and everything on either side is tested without a model. Code that consumes an agent's output, such as the plan validator and repair loop (#23), takes a `Runner` from [`test/ai/runner.ts`](test/ai/runner.ts). There are three:

| Runner | Use | Calls a model |
|---|---|---|
| `stubRunner(outputs)` | Unit tests. Returns scripted outputs in order, e.g. a bad plan then a good one | No |
| `replayRunner(dir)` | Replay tests, against a recorded real run in [`test/ai/recordings/`](test/ai/recordings/README.md) | No |
| `liveRunner(caps)` | `npm run eval` only. Headless `claude -p --model <m> --max-turns <n> --max-budget-usd <usd> --output-format stream-json --verbose`, with only `Read`, `Write`, `Edit` and `Bash(better-code-review:*)` | Yes |

- **What a run does.** The eval runs the skill itself (#25), not a copy of its instructions. [`test/ai/input.ts`](test/ai/input.ts) sets each run up:
  - it builds the fixture's repository and copies `skills/better-code-review/` into its `.claude/skills/`
  - it puts a `better-code-review` that runs this checkout's `src/cli/main.ts` first on PATH, so no build is needed
  - it sends the short prompt in `test/ai/prompts/skill.md`

  The agent follows SKILL.md. The run's output is the `plan.json` it leaves in the review directory.
- **Model input and staleness.** A recording stores the hash of its model input. The hash covers the task's prompt, the skill's files (`HASHED_SOURCES`: `SKILL.md` and every reference) and the fixture's `planner-input.md` (#22). So any edit to the skill makes every recording stale. If the input changes, `npm test` fails the recording as stale and names the command that re-records it. It never falls back to a live call.
- **Input size.** `test/ai/input.test.ts` estimates each fixture's input size (characters ÷ 4, no API call) and fails above a per-fixture ceiling, so input bloat fails a normal test.

### `npm run eval`

**This spends real AI usage. Ask before running it** (AGENTS.md), and say which model, fixtures and budget you plan to use.

```bash
npm run eval                                 # smoke: claude-haiku-5-5 on signature, $0.25 cap
npm run eval -- --fixture same-name --model claude-sonnet-5-5
npm run eval -- --tier quality --max-budget-usd 2 --allow-large-budget
```

| Tier | Model | Fixtures | Use |
|---|---|---|---|
| `smoke` (default) | `claude-haiku-5-5` | `signature` | Checks that the workflow finishes and its output validates |
| `quality` | `claude-sonnet-5-5` | All of them | For #26, and after prompt or skill changes |

- **Budget.** `--max-budget-usd` is passed to every run (default $0.25). A cap above $1 per run needs `--allow-large-budget`. The worst case for the whole eval is printed before it starts.
- **Cost log.** Each run's cost and token usage are printed and appended to `.cache/eval/costs.jsonl`.
- **Transcripts.** Each run's full stream-json transcript goes to `.cache/eval/transcripts/` for debugging bad runs. It is gitignored and costs no extra tokens.
- **Recordings.** A run that returns a schema-valid plan is recorded to `test/ai/recordings/<task>/<fixture>/<model>.json`. Commit it with the change that needed it. A run that fails is not recorded. Its transcript path is printed instead.

## Dependencies

Before adding a dependency, check its licence against the [dependency licence policy](docs/adr/0002-project-license.md#dependency-licence-policy). CI runs `npm run licenses`, which fails on any production dependency whose licence is neither allowed nor an approved exception. The machine-readable policy is [`scripts/license-policy.json`](scripts/license-policy.json); an approved exception is added there and to the ADR in the same PR.

## Pull requests

- Branch from a fresh `main`.
- Reference the issue the change belongs to.
- `npm run check` should pass; CI runs it on Linux, macOS and Windows.
