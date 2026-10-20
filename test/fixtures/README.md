# Fixture portfolio

Reproducible Git changes for testing every milestone, from design reference §18.4 (issue #9). Each fixture is a TypeScript module holding a base snapshot, the changes on top of it, and the facts the deterministic graph must show. Repositories are built from these by code, never committed as `.git` directories.

For v0.1 the portfolio is **TypeScript only**. The signature fixture also keeps its Python half. Python, Java, Go and a mixed-language HTTP/API change are #77.

| Fixture | §18.4 case | What it shows |
|---|---|---|
| `signature` | Static reference vs same-name symbol; unchanged but affected caller | The MVP spec's signature fixture (#3, #4): `formatPrice` gains `currency`, 3 of 4 callers are updated, `emailSummary` is not and is absent (D12); `legacyLabel` calls a different `formatPrice` and is rejected by import resolution |
| `ten-callers` | One changed function + ten changed callers | Ten `possible` edges to `parseDate`, one per file |
| `unchanged-caller` | Changed function with an unchanged but affected caller | A contract change (`findUser` now throws). The caller is not shown (D12) |
| `removed-calls` | Removed / replaced calls | A deleted function and a removed call, both found on the old side only (`sides: old`, #66) |
| `rename-move` | Renames and moves | A renamed function in a moved file (one edge on both sides), and a pure move with a hunk-less file node |
| `independent-roots` | Multiple independent change roots | Three unrelated changes, no edges |
| `feature-flow` | API route → service → persistence → tests | One edge per layer, and a test-file edge from a `describe` titled like the function under test |
| `interface-impl` | Interface implementation changes | `implements` edges from a changed and a new class; a call through the interface stays `possible` to both implementations |
| `same-name` | Static reference vs same-name unrelated symbol | Three changed `validate`s: import resolution keeps each plain call to its own, while the receiver call stays `possible` to all three |
| `tests-and-config` | Test- and config-only edits | File nodes for `package.json`, `tsconfig.json` and a workflow; a test file; no edges, since the code under test is unchanged |
| `dynamic-calls` | Dynamic calls / reflection | Calls through computed properties and `Reflect.apply` make no edge |
| `unsupported-binary` | Unsupported language + binary files | File nodes for a PNG, Ruby, Go and Markdown |
| `large-generated` | Large generated diff / deeply connected graph | A 2,000-function generated file (skipped), a JSON file over the 1 MiB cap, a 30-step call chain, and 120 callers capped at 100 |

## Files

| File | Contents |
|---|---|
| `fixture.ts` | The `Fixture` and `ExpectedFacts` types, and helpers |
| `<name>.ts` | One fixture each |
| `index.ts` | `FIXTURES`, the portfolio in §18.4 order |
| `repo.ts` | `buildFixtureRepo()`, and the deterministic Git plumbing `TestRepo` builds on |
| `portfolio.test.ts` | Runs `generate --no-lsp` on every fixture and checks its facts |

## Expected facts

`expected` is what `generate --no-lsp` must produce. Each list is exact and in any order:
- `files`: `path tier`, then `test` and a skip or omission reason when there is one, e.g. `assets/logo.png git-only binary`.
- `nodes`: `kind displayName`, e.g. `symbol formatPrice`, `file package.json`.
- `edges`: `from relation to (sides)`, e.g. `checkoutSummary calls formatPrice (both)`. A test file's edge starts from its path.
- `caps`: `name relation shown/total`.

When several nodes share a display name, each one is written with its path after it, e.g. `validate [src/users/validate.ts]`. The test also checks two invariants for every fixture: every hunk is on a node, and nothing is `verified` without a language server.

`later` lists the facts that need more than that, such as a language server or a later milestone. They are not checked yet: #21 turns the language-server ones into assertions, and #26 the planner ones.

## Using a fixture

```bash
npm run fixtures -- --list
npm run fixtures -- signature /tmp/signature   # main = head (checked out), tag base = base
cd /tmp/signature && node <repo>/src/cli/main.ts generate --commit main
```

In tests, `buildFixtureRepo(dir, fixture)` builds the repository without a checkout. The commit target reads Git objects directly.

## Adding a fixture

1. Write `<name>.ts`, exporting a `Fixture`, and add it to `index.ts`.
2. Write the facts you expect *before* running it. Then run `npx vitest run test/fixtures` and look at every difference. Either the fixture or your expectation was wrong, or you found a bug. Don't copy the output into the expectations without reading it.
3. Add a row to the table above.
