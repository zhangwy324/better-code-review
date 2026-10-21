# ADR 0002: Project licence and dependency licence policy

**Status:** Accepted · **Date:** 2026-10-18 · **Issue:** #5 (part of #1, Milestone M0)
**Refs:** design reference §15.2, §18 ("dependency/license checks"), §19.5 Q1 · [ADR 0001](0001-analyzer-runtime.md) § "Licences"

## Decision

1. **The project is licensed under MIT** (`LICENSE` at the repository root). Copyright is held by David Zhang.
2. **Contributions are accepted under MIT too ("inbound = outbound").** There is no CLA and no DCO for now.
3. **Dependencies must follow the [dependency licence policy](#dependency-licence-policy) below.** CI enforces it once CI exists (#7).
4. **Every distributed bundle carries the notices of the third-party code inside it.** This includes the CLI bundle, each generated `review.html` and each language bundle.

## Context

The design reference says the project is open source and leaves the licence open (§19.5 Q1). The licence had to suit three goals:
- **Adoption.** The tool runs locally on developers' machines through an Agent Skill. Teams have to be allowed to install it at work.
- **Contributions** from outside the project.
- **Compatibility** with the dependencies chosen in ADR 0001 and the candidates in §15.2.

The project has no hosted service (§3.4), so copyleft would add little protection. Closed forks running as SaaS are not a business risk the project is trying to prevent.

## Options considered

| Option | For | Against |
|---|---|---|
| **MIT** (chosen) | Shortest and most familiar. The npm default, so legal teams approve it routinely. Matches almost all of our dependencies | No explicit patent grant. No clause covering contributions |
| Apache-2.0 | Explicit patent grant and patent-retaliation clause. §5 states contribution terms, so no CLA is needed | Longer. Requires a `NOTICE` file, and marking of modified files in forks. Incompatible with GPLv2-only code |
| MIT OR Apache-2.0 | Users choose either licence | Two licences to maintain. Rare on npm |
| MPL-2.0 | Changes to our files in distributed forks must be published | Flagged by some corporate policies. Does not stop SaaS use |

MIT was chosen for simplicity "for now". See [Revisiting](#revisiting).

## Dependency licence survey (2026-10-18)

Sources: `npm view <pkg> license` and ADR 0001.

| Component | Licence | How it reaches users |
|---|---|---|
| `web-tree-sitter` 0.27.1 | MIT | Bundled in the CLI |
| `tree-sitter-{typescript,javascript,python,java}` | MIT | `.wasm` built in; query files derived from their `tags.scm` |
| `tree-sitter-kotlin` (fwcd) | MIT | Language bundle |
| `react`, `react-dom` 19.x | MIT | Bundled in `review.html` |
| `@xyflow/react` (React Flow) 12.x | MIT | Bundled in `review.html` (candidate, §15.2) |
| `codemirror`, `@codemirror/merge` 6.x | MIT | Bundled in `review.html` (candidate, §15.2) |
| `@lezer/{common,lr,highlight,javascript,python,java}` 1.x | MIT | Bundled in `review.html` (#29: syntax highlighting in place of CodeMirror) |
| `zod` 4.x | MIT | Bundled in the CLI (candidate, §15.2) |
| **`elkjs` 0.12.0** | **EPL-2.0 OR GPL-3.0-or-later** | Bundled in `review.html` (candidate, §15.2). See [elkjs](#elkjs) |
| `typescript-language-server`, `typescript` | Apache-2.0 | Detected on the user's machine; never bundled |
| `pyright` | MIT | Detected on the user's machine; never bundled |
| `serena-agent` (SolidLSP) | GPL-3.0-or-later | Not used (ADR 0001) |

## Dependency licence policy

The policy applies to code we **distribute**: runtime dependencies bundled into the CLI, the viewer or `review.html`, grammars in language bundles, and code we vendor or copy.

| Category | Licences (SPDX) | Rule |
|---|---|---|
| **Allowed** | MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, Unlicense, CC0-1.0, BlueOak-1.0.0 | Use freely. Keep the notices |
| **Review required** | MPL-2.0, EPL-2.0, LGPL-*, CC-BY-4.0, anything not listed | Allowed only after the dependency is added to [Approved exceptions](#approved-exceptions) with its obligations. Use it unmodified as a separate module; don't copy its code into our files |
| **Not allowed** | GPL-*, AGPL-*, SSPL-1.0, BUSL-1.1, CC-BY-NC-*, no licence or `UNLICENSED` | Not distributed. A dual-licensed package is fine if one of its options is allowed or approved; we use that option |

Other rules:
- **Dev-only dependencies** (build, lint and test tools that are never shipped) may use any open-source licence except the "no licence" cases. A GPL build tool is fine; a GPL library bundled by that tool is not.
- **Detected tools** (language servers, `git`, the user's own TypeScript) are run as separate processes on the user's machine and are never shipped by us. The policy does not apply to them. If one is ever bundled or downloaded by us, it becomes a distributed dependency.
- **Copied code** (e.g. borrowing from sem, which is MIT OR Apache-2.0) keeps its original copyright header and is listed in the third-party notices.
- **Language bundles** record the grammar's SPDX licence in their manifest (ADR 0001) and ship the grammar's licence text. CI refuses to build a bundle whose grammar licence fails this policy.

### Notices in distributed bundles

MIT, BSD and Apache-2.0 all require the licence notice to travel with copies of the code, including minified bundles.
- The **CLI package** ships a generated `THIRD_PARTY_NOTICES` file.
- **Each `review.html`** embeds the notices for the viewer code bundled inside it, for example in a collapsed "Licences" panel or an HTML comment. A single self-contained file is a copy of that code, so it has to carry the notices itself.
- The notices are generated at build time from the dependency tree, not maintained by hand.

### elkjs

`elkjs` is the only §15.2 candidate that is not permissive. We would take it under **EPL-2.0**.
- EPL-2.0 is copyleft per file. Using it unmodified as a separate module inside a bundle under a different licence is generally understood to be allowed, as long as the bundle says that elkjs is under EPL-2.0 and where its source is available.
- Modifying elkjs files would require publishing those modifications under EPL-2.0.
- This is my reading of the licence, not legal advice.

**Decision deferred to the graph-layout work (#30):** either record elkjs as an approved exception with those obligations, or choose a permissive layout library (e.g. `dagre` / `@dagrejs/dagre`, MIT) if it is good enough.

### Approved exceptions

None yet.

## Enforcement

Since #7, the `dependency licences` CI job runs `npm run licenses` ([`scripts/licenses.ts`](../../scripts/licenses.ts)). It:
- lists the licences of all production dependencies with `license-checker-rseidelsohn` and fails on any licence that is neither allowed nor an approved exception. SPDX expressions are evaluated properly: `MIT OR GPL-3.0` passes, `MIT AND GPL-3.0` does not;
- checks the built-in grammars vendored in `src/analysis/structural/grammars/` (#14) the same way, from their manifest;
- generates `THIRD_PARTY_NOTICES` from the same data. The file is not committed: `npm pack` regenerates it, and CI uploads it as a build artifact.

The machine-readable policy is [`scripts/license-policy.json`](../../scripts/license-policy.json). A test fails if its allowlist drifts from the **Allowed** row above. An approved exception is added to both that file and [Approved exceptions](#approved-exceptions) in the same PR.

Since #28, the viewer build embeds the notices for the code bundled into each `review.html`: this project's `LICENSE` and the licences Vite's `build.license` collects (`vite.config.ts`, [`src/renderer/README.md`](../../src/renderer/README.md)).

Not yet automated: dev-only dependency licences (still checked in the PR by whoever adds them) and grammar licences in language bundles (#45).

## Consequences

**Positive**
- No friction for adoption or reuse. MIT matches the ecosystem we build on.
- One licence file, no CLA and no `NOTICE` maintenance.

**Negative, accepted**
- **No explicit patent grant** from contributors.
- **Contribution terms are implicit.** We rely on the "inbound = outbound" convention, which the GitHub Terms of Service state for content added to a repository that has a licence notice (§D.6).
- **The notice requirement reaches every `review.html`.** The renderer has to embed generated notices (#28).

## Revisiting

Revisit when outside contributions become significant, or if a company asks for patent terms.
- Moving to **Apache-2.0** later should be straightforward, because MIT allows the code to be distributed under other terms as long as the MIT notices are kept. Existing contributions would stay under MIT alongside the new licence.
- Adding a **DCO** sign-off (`git commit -s`) is a cheap way to make contribution terms explicit without a CLA.
