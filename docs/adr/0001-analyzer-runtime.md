# ADR 0001: Analyzer runtime

**Status:** Accepted · **Date:** 2026-10-18 · **Issue:** #4 (part of #1, Milestone M0)
**Refs:** design reference §10.3–10.5, §14, §17.4 spikes 1–4, §19.4 Q1 · `docs/research/existing-tools.md` § "Analysis approach"

## Decision

1. **Runtime: TypeScript on Node.js only.** The CLI, the analyzer and the viewer share one language and one package. There is no Python sidecar.
2. **Parsing: `web-tree-sitter` with `.wasm` grammars**, not `tree-sitter-language-pack`.
   - **Built-in languages:** TypeScript/TSX, JavaScript, Python and Java. Their grammars ship inside the package, so they work offline from the first run.
   - **Other languages are downloaded on demand** as *language bundles*, by an explicit command (e.g. `better-code-review languages add kotlin`). See [Language bundles](#language-bundles).
   - **Entity extraction uses our own query files** (`.scm`), one per language, seeded from each grammar's upstream `tags.scm` and covered by tests.
3. **LSP: our own minimal LSP client** (JSON-RPC over stdio), not multilspy and not SolidLSP. It stays the **optional** precision tier decided in #3.

This amends one detail of the pipeline recorded in #3: the parser is `web-tree-sitter` rather than `tree-sitter-language-pack`. The pipeline itself (deterministic candidates → optional LSP verification → AI adjudication) is unchanged.

## Context

#3 settled the analysis pipeline and made LSP optional. The runtime choice therefore had to optimise for:
- tree-sitter bindings that can extract entities in TS, Python and Java
- a lightweight optional LSP client
- easy distribution with the Agent Skill, offline and on all three desktop OSes

The design reference left three options open: **TypeScript only**, a **Python/SolidLSP sidecar**, or a **hybrid**.

## Evidence (spike, 2026-10-18)

All experiments ran on Linux x64 (WSL2), Node 24.21, Python 3.12. The scripts lived in a scratch directory and are not committed; the [Reproduction](#reproduction) section lists the steps.

### Entity extraction: TS, Python, Java

Fixtures covered the awkward constructs: arrow and function-expression assignments, overloads, default exports, decorators, nested functions, Python lambdas, inner classes, Java constructors, records and enums.

| Binding | Query API | Result on fixtures |
|---|---|---|
| `tree-sitter-language-pack` 1.22.1, **Node** | **None.** Node walking only; `getTagsQuery()` returns the text but nothing can run it | Built-in `process()` missed **Java constructors and records**, TS `const f = function…`, the default export and Python lambdas. It can't be adjusted |
| `tree-sitter-language-pack` 1.22.1, **Python** | Yes. It returns real `py-tree-sitter` objects | With tags queries: same entities as web-tree-sitter |
| **`web-tree-sitter` 0.27.1** + official grammar `.wasm` | Yes | With the same tags queries: same entities as the Python binding |

- The differences between the last two came from **which `tags.scm` version** each source shipped, not from the runtime. For example, the pack's Java query has constructors and the npm grammar's doesn't.
- Upstream tags queries also have gaps (Java enums and records; TS needs the JS query added to it). We will own these query files either way.
- **The pack's import and export extraction is too rough to use.** `ImportInfo.source` holds the whole statement rather than the module path, and the re-export `export { formatPrice as fmt }` loses its alias.

### Offline and distribution

| | language pack (Node) | language pack (Python) | web-tree-sitter |
|---|---|---|---|
| First run with no network | **Fails.** It fetches a 22 MB platform bundle from GitHub releases (`Failed to fetch manifest … Connection refused`) | Same core, same behaviour | Works |
| Offline with parsers shipped | Works: a pre-filled cache directory (3 MB of `.so` for TS, Python and Java) via `TREE_SITTER_LANGUAGE_PACK_CACHE_DIR` | Same | n/a |
| Platform-specific files | Yes: the engine `.node` (~5 MB) **and** every parser `.so`. The npm package is 40 MB because it carries all 8 platforms | Wheel 5.7 MB + parsers | No. One `.wasm` per language runs everywhere |
| Size for TS + Python + Java | ~5.5 MB engine + ~3 MB parsers, **per platform** | 5.7 MB + ~3 MB per platform, plus a venv | 210 KB engine + ~2.3 MB grammars, **for all platforms** |
| Install prerequisites | Node | **pip or uv**. This Ubuntu's `python3` has neither pip nor `ensurepip`, so `python3 -m venv` failed | Node |

**Bundling check:** esbuild produced one 156 KB `cli.mjs`. With the engine and Java and Python grammars, the whole package was 1.3 MB, and it ran correctly from an unrelated directory. The only requirement is passing `locateFile` to `Parser.init()`.

npm 11 now holds back install scripts by default (`npm warn install-scripts`), and `npx skills add` only copies files. Any design that needs a postinstall download is therefore unreliable.

### Performance (median of 5, parse + entity extraction)

| File | web-tree-sitter (parse + query) | language pack native (parse + `process()`) |
|---|---|---|
| Python, 3.5k lines | 10 + 3 ms | 8 ms |
| Python, 9.5k lines | 28 + 7 ms | 24 ms |
| TS, 11k lines (`typescript.d.ts`) | 31 + 13 ms | 28 ms |
| JS, 9 MB / ~200k lines (`typescript.js`) | 696 + 324 ms | 862 ms |

- **Speed:** WASM parsing alone is ~1.7–2× slower than native. End to end, the two are equivalent.
- **Memory:** the 9 MB file pushed RSS to ~600 MB, because WASM linear memory grows and doesn't shrink. The analyzer must cap or skip huge and generated files (design reference §14.2).

### Languages without a published `.wasm`

- Most major grammar packages ship a `.wasm`: TS, JS, Python, Java, Go, Rust, C#, Ruby, C++ and PHP were checked. **Kotlin does not.**
- **Building one is cheap.** `tree-sitter build --wasm` (tree-sitter-cli 0.25.10) on `fwcd/tree-sitter-kotlin` (MIT, repo at 0.4.0 while npm has 0.3.8) pulled the official `emscripten/emsdk` Docker image and built a 5.8 MB `.wasm` in ~54 s.
  - It loaded in web-tree-sitter 0.27.1 (grammar ABI 14).
  - A 4-line query found the class, secondary constructor, member, companion and top-level functions.
  - The `object` declaration pattern did not match on the first try. **Query files need per-language tests.**
- `tree-sitter-wasms` (36 prebuilt grammars, Unlicense) was last published 2025-10. It is too stale to depend on.

### LSP client: signature-propagation scenario

The fixture from #3: `formatPrice(amount)` gains `currency`, 3 of 4 callers are updated and `emailSummary` is missed. Name collisions are added: `legacy/price.ts::formatPrice`, `Fmt.formatPrice`, and a re-export `formatPrice as fmt` called from `aliasCaller`. The Python side changes `tax(amount)` to `tax(amount, rate=0.1)`, with a colliding `Calc.tax` method and a module-alias caller `t.tax(a)`.

The pipeline was: `git grep -w` candidates → enclosing entity via web-tree-sitter → `textDocument/references` and `callHierarchy/incomingCalls`.

| Client / server | Outcome |
|---|---|
| **Own client (~100 lines, no deps)** + `typescript-language-server` 6.0.2 on TypeScript 5.9.3 | All real references verified. All 3 collisions rejected (`legacy/price.ts`, `legacyLabel`, `Fmt.formatPrice`/`viaMethod`). Also found `aliasCaller` |
| Own client + **TS 7.0.2 native `tsc --lsp --stdio`** | Same callers. `references` omits import lines. No `tsserver` needed |
| Own client + `pyright` 1.1.414 | Verified `order_total`, `refund` (`t.tax`) and the import. Rejected `Calc.tax` and its caller |
| `multilspy` 0.1.1 + jedi-language-server | Correct references, ~0.6 s including start-up. Adds a Python runtime and nothing our client lacks |
| SolidLSP (inside `serena-agent` 2.0.0) | Not run. Ruled out on licence and packaging (below) |

Behaviour that shapes #16 and #17:
- **`references` can return an empty list without any error** while the server is still loading the project. Both tsserver and pyright did this on the first request; correct results came after a ~2 s wait. `callHierarchy/incomingCalls` was correct immediately on both. The client must treat an empty result before readiness as *unknown*, not *no callers*. It should cross-check with call hierarchy and use progress notifications or a bounded retry.
- **`typescript@latest` is now 7.x** (the Go-native compiler) and has no `tsserver.js`, so `typescript-language-server` fails to start unless TS 5.x is available. We should prefer the project's own TypeScript, support TS 7's built-in `--lsp`, and report which one was used.

### Licences

| Component | Licence | Notes |
|---|---|---|
| `web-tree-sitter` | MIT | |
| Grammars checked (typescript, javascript, python, java, kotlin) | MIT | Re-check each grammar before adding it to a bundle |
| `tree-sitter-language-pack` (Node and Python) | MIT | Not adopted |
| `typescript-language-server`, `typescript` | Apache-2.0 | Detected on the user's machine; never bundled |
| `pyright` | MIT | Detected on the user's machine; never bundled |
| `multilspy` | MIT | Not adopted |
| **`serena-agent` 2.0.0** | **GPL-3.0-or-later** | Per-component: SolidLSP files are MIT, but the only published package containing them is GPL. SolidLSP (~44k lines) imports GPL `serena.util.*` in 5 places, so reusing it means vendoring it and rewriting those helpers |

The project licence itself is #5.

## Language bundles

A **language bundle** contains a grammar `.wasm`, our query file, and a manifest: grammar version and source commit, the engine version it was built for, sha256, and licence.

- **Built in:** TS/TSX, JS, Python, Java (~4–5 MB in all).
- **On demand:** `better-code-review languages add <lang>` downloads a bundle from **our own GitHub release assets** into the user cache directory and verifies the checksum.
- **One build path for all languages.** CI builds every bundle with `tree-sitter build --wasm` from the grammar's source. A missing upstream `.wasm` is therefore not a special case, and grammar and engine versions stay pinned together.
- **No silent downloads during a review.** Unsupported languages still show every hunk, with callers labelled `possible` from text search. The review also says how to add the language. The agent may run the command with the user's approval.
- **Query quality tiers:**
  - **supported:** our query file, with tests
  - **community:** the grammar's upstream `tags.scm`, unverified
  - **text-only:** no grammar

  The tier is reported per language, like LSP capability.
- **Sandboxing:** a downloaded `.wasm` grammar cannot touch the file system or network. A downloaded native `.so`, as the language pack uses, runs as ordinary code on the user's machine.

## Consequences

**Positive**
- One runtime and one package manager; the viewer's build toolchain is reused.
- Works offline for built-in languages and needs no native binaries.
- Entity accuracy is under our control (one query line per fix).
- The LSP client has no dependencies and works with any stdio server.

**Negative, accepted**
- **No long tail for free.** Each language needs a bundle and, to be "supported", a tested query file. This replaces the language pack's 372 languages with no work per language.
- **We own a CI job** that builds bundles (Docker + tree-sitter CLI) and a release-hosting convention.
- **Version compatibility:** a web-tree-sitter upgrade may require rebuilding all bundles. The manifest records the engine version, and bundles that don't match are refused.
- **WASM costs** ~2× slower parsing and memory that only grows. File size caps are required.
- **Trees must be freed** (`tree.delete()`) to avoid leaks in long runs.
- **Node becomes the one prerequisite.** Agent CLIs no longer guarantee Node (some ship native installers). A single-file executable (Node SEA or similar) can remove this later if needed.

## Rejected alternatives

| Option | Why rejected |
|---|---|
| **Python/SolidLSP sidecar** | Two runtimes to distribute. Python installs are unreliable (no pip or `ensurepip` here). SolidLSP is only published inside a GPL package and depends on GPL helpers. Its main benefit, LSP plumbing, took ~100 lines in TS |
| **Hybrid** (TS CLI + Python analyzer using language-pack queries + multilspy) | The query support it buys is available in Node through web-tree-sitter. It keeps all of the sidecar's distribution cost |
| **TS + `tree-sitter-language-pack` (Node binding)** | No query API: we would accept `process()`'s gaps (e.g. Java constructors) or hand-write walkers per language. Native binaries per platform. Network download on first use unless parsers are pre-shipped per platform |
| **TS + native `node-tree-sitter` + grammar packages** | Not tested. Native addons per platform need prebuilds or a compiler at install time and install scripts that npm now holds back. No upside over WASM at our file sizes |
| **multilspy as LSP layer** | Works, but it requires Python. It also downloads servers at runtime in some configurations, which goes against detecting what the user already has |
| **`tree-sitter-language-pack` as a long-tail fallback** | Deferred, not adopted. Its `.so` files can't load into web-tree-sitter, so it would be a second engine. Revisit only if bundles prove too slow to add |

## Input for #42 (candidate adjudication)

#42 has not run yet. This decision does not depend on its outcome: if #42 recommends required LSP, the same client applies. The spike did produce findings #42 should measure:
1. **Text search misses alias callers.** `aliasCaller` calls `formatPrice` through `export { formatPrice as fmt }`, and `git grep -w formatPrice` cannot see it.
   - The re-export line *is* a candidate, so the pipeline can follow it: a candidate that is an `as` alias in an import or export adds the alias name to the search.
   - Also measure how often this happens (re-exports, `import x as y`, Python `import m as t` + `t.f()`).
   - The claim "candidates own recall" holds for *textual references*, not for *callers*, until aliases are followed.
2. **Empty `references` before the server is ready** (above). Ground truth must wait for readiness, or it will under-count.
3. **Import lines are candidates.** They should map to a module-level entity, not be counted as callers.

## Gaps

- **Java LSP (jdtls) not run:** no JDK on the test machine (a JDK + jdtls is ~250 MB). The client is protocol-generic; jdtls specifics belong in #16.
- **Linux only.** macOS and Windows were not run (WASM is platform-independent; path and URI handling is not).
- **The download, verification and CI build steps for language bundles** are designed, not built.
- **No large real-repository end-to-end run.** The timings are per file, not per PR.
- **#42 results not yet available.**

## Reproduction

```bash
# Parsers
npm i @xberg-io/tree-sitter-language-pack@1.22.1              # Node binding; ts.process(src, {language})
uv venv && uv pip install tree-sitter-language-pack==1.22.1    # Python binding; Query/QueryCursor work
npm i web-tree-sitter@0.27.1 tree-sitter-typescript@0.23.2 tree-sitter-javascript@0.25.0 \
      tree-sitter-python@0.25.0 tree-sitter-java@0.23.5        # .wasm + queries/tags.scm in each package
# Offline check: TREE_SITTER_LANGUAGE_PACK_CACHE_DIR=<empty dir> HTTPS_PROXY=http://127.0.0.1:9 node -e '…process…'
# Kotlin: git clone fwcd/tree-sitter-kotlin && npx tree-sitter-cli@0.25.10 build --wasm -o kotlin.wasm .
# LSP: npm i typescript-language-server pyright typescript@5 ; typescript@7 for `tsc --lsp --stdio`
# Fixture: see docs/research/existing-tools.md appendix, plus src/reexport.ts (formatPrice as fmt),
#          src/viaAlias.ts (aliasCaller), py/ tax(amount) -> tax(amount, rate=0.1) with orders/refunds/Calc.tax
```

## Sources

- web-tree-sitter: https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web
- tree-sitter-language-pack: https://github.com/xberg-io/tree-sitter-language-pack
- tree-sitter-kotlin: https://github.com/fwcd/tree-sitter-kotlin
- multilspy: https://github.com/microsoft/multilspy
- Serena / SolidLSP licensing: https://github.com/oraios/serena (`LICENSE`, `LICENSES/`)
- typescript-language-server: https://github.com/typescript-language-server/typescript-language-server
- pyright: https://github.com/microsoft/pyright
