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
| `npm run grammars` | Re-vendors the built-in tree-sitter grammars from their pins ([`src/analysis/structural/README.md`](src/analysis/structural/README.md)) |

## Layout

One package, one language (ADR 0001). Modules are folders under `src/`, created when their first code lands:

| Folder | Contents |
|---|---|
| `src/cli/` | Commands, options, orchestration. `main.ts` is the `better-code-review` binary |
| `src/git/` | Snapshot and diff normalisation |
| `src/analysis/` | Structural (tree-sitter) and semantic (LSP) analysis |
| `src/graph/` | Deterministic change graph builder |
| `src/planning/` | Review plan prompts, validation and fallback plan |
| `src/schemas/` | Versioned data contracts; conventions and versioning policy in its [`README.md`](src/schemas/README.md) |
| `src/renderer/` | `review.html` bundling |
| `src/viewer/` | The React viewer |

- `schemas/` holds the generated JSON Schema files. Don't edit them; change `src/schemas/` and run `npm run schemas`.
- Unit tests sit next to the code as `*.test.ts`. The fixture portfolio, Git changes that tests across milestones share, is in `test/fixtures/` ([`README.md`](test/fixtures/README.md)).
- Relative imports use the `.ts` extension; `tsc` rewrites them to `.js` on build.
- Files the compiled code reads at run time (grammars, query files) are copied to `dist/` by `scripts/copy-assets.ts` during `npm run build`; add new asset folders there.
- `scripts/` holds repository tooling. Scripts are TypeScript run directly by Node (`node scripts/x.ts`), so they may only use erasable syntax (no `enum`, no parameter properties).

## Dependencies

Before adding a dependency, check its licence against the [dependency licence policy](docs/adr/0002-project-license.md#dependency-licence-policy). CI runs `npm run licenses`, which fails on any production dependency whose licence is neither allowed nor an approved exception. The machine-readable policy is [`scripts/license-policy.json`](scripts/license-policy.json); an approved exception is added there and to the ADR in the same PR.

## Pull requests

- Branch from a fresh `main`.
- Reference the issue the change belongs to.
- `npm run check` should pass; CI runs it on Linux, macOS and Windows.
