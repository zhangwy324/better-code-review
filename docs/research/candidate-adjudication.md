# Candidate search and AI adjudication: validation on real PRs

**Status:** Done · **Date:** 2026-10-19 · **Issue:** #42 (part of #1, Milestone M0)
**Follow-up:** [#43 results](#43-results-the-ai-step-as-built) measure the AI step as built (2026-10-20).
**Refs:** `docs/research/existing-tools.md` § "Analysis approach" · [ADR 0001](../adr/0001-analyzer-runtime.md) · [MVP spec](../mvp-spec.md) D2, D6, D12

## Recommendation

**Go: adopt the pipeline with changes, for relationships between changed entities (MVP spec D12).**

| Step | Decides | Measured here (D12 scope, 6 PRs) |
|---|---|---|
| 1. Text search for each changed name | Recall | Found 816 of 819 LSP references. The 3 misses are `super(...)`/`this(...)` constructor chaining |
| 2. tree-sitter: classify hits, map to enclosing entity | Drops comments, strings, declarations, keys | |
| 3. Unambiguous hits (one definition, plain call, no alias) accepted | 164 hits | 100% precise |
| 4. **New:** import-path resolution | 144 hits | 126 `yes` at 98% precision, 18 `no` at 100% |
| 5. **New:** test files collapse to (file, changed entity) pairs (D2) | 274 test hits become 49 pairs, 15 settled by step 4 | |
| 6. LSP, when installed and healthy | Verifies or rejects the rest | Accurate, with the query strategy below |
| 7. AI on what is left | 636 decisions | 100% precision, 97.2% recall, 0.5% false rejections (audited) |

Under D12 the AI step is affordable without sampling: **84 calls and $1.59 for all 6 PRs.** The largest PR, jsoup (444 changed lines, 61 changed entities), took 59 calls, $1.21 and 95 s with 4 calls in parallel. The other PRs cost under $0.12 each.

**Changes the pipeline needs** (detail in [Pipeline changes](#pipeline-changes)):
1. Entity spans include leading doc comments.
2. Constructor roots also search `super(`/`this(`.
3. Overloads are merged into one changed entity.
4. Add import-path resolution before LSP and AI. For constructors, only call sites count.
5. Test files relate at file level (spec D2).
6. LSP query strategy: query constructors through the class, query overridden base methods with a receiver-type filter, check readiness, and only trust a negative after a project-health check.
7. AI context policy: add the receiver's declaration and the re-export line, and state that type uses count for class roots. Keep `unsure` as `possible`.

**Repo-wide is not affordable without a healthy LSP, which supports D12.** The same 6 PRs had 11,224 ambiguous hits repo-wide, and 8,807 were still undecided after import resolution. At the measured $0.0025 per decision, that is about $22 for the 6 PRs, $15.50 of it for jsoup alone, and roughly 100× the D12 volume. Common names drive it: up to 600 candidate callers per changed entity (jsoup `html`) and 556 (gson `Gson`).

## What was measured

### PR set

Selected by shape, by mining each repo's first-parent history for commits that change a function signature with callers in other files. No third-party code is copied into this repo.

| Lang | Repo | PR | Base → head | Licence | Size (± lines, files) | Shape |
|---|---|---|---|---|---|---|
| TS | date-fns/date-fns | #3869 (commit `7f352cf`) | `60a29b2` → `7f352cf` | MIT | 211, 6 | `formatDistance` signature; **87 same-name definitions** (locales); re-export aliases (`as fn`) |
| TS | honojs/hono | #3770 | `b1335f9` → `efc8a46` | MIT | 69, 2 | `Context.text/json/html`: very common names, receiver calls |
| Py | encode/httpx | #2879 | `b471f01` → `f8981f3` | BSD-3-Clause | 451, 11 | Module functions `get/post/request` collide with `Client` methods; module-attribute calls (`httpx.get`) |
| Py | pallets/click | #2796 | `8a47580` → `4ece17a` | BSD-3-Clause | 310, 10 | Overridden methods (`make_metavar`, `get_metavar`, `convert`); calls go through the base class |
| Java | google/gson | #2864 | `286843d` → `8526dbd` | Apache-2.0 | 528, 3 | Package-private `Gson(...)` constructor; class name used in 172 files |
| Java | jhy/jsoup | #2321 | `969cb78` → `af7999d` | MIT | 444, 18 | Overloads (`html`, `append`), new class, many overrides |

Full SHAs are in [Reproduction](#reproduction). PR sizes run from 69 to 528 changed lines.

**Sanity check:** the #3/#4 signature fixture was rebuilt (#9 isn't built yet). Repo-wide, it finds the unchanged `emailSummary` and finds `aliasCaller` only by following `export { formatPrice as fmt }`. The collisions (`legacy/price.ts`, `Fmt.formatPrice`) stay candidates that LSP and import resolution reject. Under D12 only the 4 changed callers are in scope, and all are found.

**No missed or stale caller was found in the 6 PRs.** Merged PRs compile, and click's in-repo callers were all updated. That fits D12's premise that compilers catch most broken callers in typed code.

### Setup

- **Parser:** `web-tree-sitter` 0.27.1 with our own query files, per ADR 0001. The issue's "language pack check" was run against this instead.
- **Ground truth:**
  - typescript-language-server 6.0.2, using each project's own TypeScript (5.4.5 and 5.6.2)
  - pyright 1.1.414
  - jdtls 1.62.0 in Docker on Temurin 25 (jdtls 1.62 requires Java 25)
  - Dependencies were installed so projects resolve. Java via Maven; Python via `pip --target` in Docker, because the host has no pip.
- **AI:** `claude -p --model claude-sonnet-5-5` with no tools and a replaced system prompt, 12 groups per call, 4 calls in parallel. Costs are the CLI's list-price figures, including prompt-cache writes.
- **Scopes:** every number is computed for the whole repo and for the D12 scope (hits inside changed entities, on the head side). The repo-wide numbers are the evidence for D12.

## Results

### 1. Entity extraction and hunk attachment

| | Result |
|---|---|
| Hunks | 263: 182 inside one entity, 14 spanning entities, 67 module level |
| Hunk home agrees with LSP `documentSymbol` | 219/234 (94%) |
| Entity spans equal to LSP | 1,031/1,394 exact; **1,380/1,394 (99%) equal once leading doc comments are ignored** |

The disagreements fall into four groups:
- **Leading doc comments.** tree-sitter spans start at the declaration; jdtls includes the Javadoc. Hunks that only change a doc comment (8 here) would attach to the enclosing class. *Fix: extend entity spans over adjacent leading comments.* Python decorators are already inside `decorated_definition`.
- **Test callbacks.** TS `describe(...)`/`it(...)` callbacks are LSP symbols but not named entities, so those hunks attach at module level. That's acceptable under D2 (file-level for tests).
- **LSP listing artefacts, not tree-sitter errors.** pyright lists one symbol for `@overload` groups and property getter/setter pairs. tsserver extends some interface spans.
- **TS type-member hunks** (`ResponseInit.status`) attach to the interface. That's fine.

**Verdict:** spans are accurate enough to attach every changed hunk, given the leading-comment fix.

### 2. Candidate search

Candidate callers (distinct enclosing entities) per changed entity:

| | Repo-wide median / p90 / max | D12 median / p90 / max |
|---|---|---|
| date-fns | 1.5 / 106 / 106 | 1.5 / 6 / 6 |
| hono | 3 / 42 / 96 | 1 / 3 / 9 |
| httpx | 11 / 150 / 197 | 2 / 13 / 13 |
| click | 2 / 30 / 30 | 2 / 6 / 6 |
| gson | 2 / 556 / 556 | 2 / 4 / 4 |
| jsoup | 4 / 160 / 600 | 3 / 9 / 58 |

Worst cases repo-wide are common names: jsoup `html` (16 definitions, 600 entities, 928 code hits), gson `Gson` (556 entities), httpx `request` (197), hono `text` (958 code hits). Under D12 the worst is jsoup's new class `QuietAppendable` (58 changed entities use it).

### 3. Recall against LSP

| | Repo-wide | D12 |
|---|---|---|
| LSP references found by text search | 3,920/3,923 | 816/819 |
| Found only by following an `as` alias | 8 (date-fns `fp/` wrappers) | 0 (1 in the fixture) |

All 3 misses are **constructor chaining**: `super(root, accum, settings)` twice in jsoup and `this(GsonBuilder.DEFAULT)` in gson. The call never names the class. *Fix: for constructor roots, also search `super(` in direct subclasses and `this(` in the same class.*

**How often aliases matter** (the #4 question): every LSP reference hidden behind an alias was found once alias following was on. Repo-wide, 8 references (all in date-fns) needed it; none did inside D12 on these PRs. Python `import m as t` + `t.f()` is a textual hit anyway (`f` still appears).

**Ground truth needed care.** Without these steps, LSP silently under-reports:
- **Project not resolving.** click's `src/` layout isn't installed; pyright found 4 references to `Choice` instead of 37, with no error. Fixed by adding `src` to its extra paths.
- **Overrides.** `references` on an overriding method returns 0 when callers go through the base type: 7 of click's changed methods, 5 of jsoup's. Querying the overridden base method recovers them (7/7 and 2/5), but **over-approximates**: it also counts calls whose receiver is statically a sibling class, and `super.x()` calls. See the [audit](#4-ai-adjudication).
- **Constructors.** Querying from Python `__init__` returns nothing; query from the class name and keep only call sites. jdtls reports `new Gson()` ranges starting at `new`, so references are matched by range, not by start column.
- **Readiness.** The "empty `references` before the server is ready" problem from #4 did not occur on these repos: no changed entity got an empty first answer followed by a non-empty one. The client still waits for two identical answers. jdtls took 6–20 s to report `ServiceReady`.

### 4. AI adjudication

**What the AI was asked.** Every ambiguous in-scope hit that steps 3 and 5 left open, not just those left after import resolution, so the AI is measured on its own. Ambiguous means the name has more than one definition, or it's a receiver call, or it's an alias use. Each enclosing function is shown once, with its imports, a window around each hit and the list of same-name definitions. A test file is one question per (file, changed entity), with up to 3 example hits. No sampling.

**Run 1 (all items), audited:**

| PR | Items | Positives | Precision | Recall | False rejections | Unsure | Calls | Cost | Model time | Wall (4 parallel) |
|---|---|---|---|---|---|---|---|---|---|---|
| date-fns | 26 | 1 | 100% | 100% | 0 | 0 | 1 | $0.036 | 11 s | 13 s |
| hono | 27 | 11 | 100% | 100% | 0 | 0 | 4 | $0.074 | 15 s | 8 s |
| httpx | 11 | 7 | 100% | 100% | 0 | 0 | 3 | $0.056 | 7 s | 4 s |
| click | 23 | 20 | 100% | 100% | 0 | 0 | 11 | $0.116 | 26 s | 10 s |
| gson | 16 | 14 | 100% | 100% | 0 | 1 | 4 | $0.085 | 15 s | 7 s |
| jsoup | 528 | 338 | 100% | 97.0% | 2 | 10 | 59 | $1.214 | 295 s | 95 s |
| **Total** (incl. fixtures) | **636** | **396** | **100%** | **97.2%** | **2 (0.5%)** | **12 (1.9%)** | **84** | **$1.59** | **6.2 min** | |

Per decision: about $0.0025, 430 input and 77 output tokens. Three jsoup items came back without a verdict even after one retry; they're counted as not decided.

**Audit.** Every AI-vs-LSP disagreement in run 1 was checked by hand:
- **19 "rejections" of dispatch-only positives were correct.** The LSP dispatch query counts every call of a base method as reaching every override. The model saw that the receiver's static type rules it out:
  - `el.outerHtmlHead(...)` with `el: Element` can't reach `TextNode`'s override
  - `node` in `DataNodeTest` is a `DataNode`
  - `super.addHead(...)` calls the base, not the changed override
  - click's `self.make_metavar` there is inside `Option`, not `Argument`

  These are scored as correct.
- **2 real false rejections** (jsoup): the return type `StringBuilderAppendable` in a method declaration, for the class root `StringBuilderAppendable`. The model called it "a declaration, not a reference". The prompt didn't say type uses count for class roots. *Fix in the prompt.*
- **12 `unsure`**, mostly correct to be unsure given the context:
  - 7 are `accum.append(...)` where `accum` is a field whose declaration wasn't shown
  - 1 is the fixture's `fmt(...)`, whose re-export file wasn't shown
  - *Fix in the context policy: include the receiver's declaration (field, parameter or local) and the alias's re-export line.*
- **0 false positives** in run 1.

**Consistency (3 runs).** Runs 2–3 repeated every PR except jsoup, plus 10 of jsoup's 58 calls spread across it: 178 items repeated 3 times.
- **174/178 (97.8%) identical in all 3 runs.**
- **No item flipped between `yes` and `no`.** The 4 that changed moved between a firm verdict and `unsure`, and 2 jsoup items became `yes` on runs 2–3: an implicit `html(sb)` call in `Element`, whose override set wasn't shown.
- With `unsure` kept as `possible`, the run-to-run variation never hides a real caller.

**Cost of repeat runs.** Runs 2–3 cost about a quarter of run 1 because identical prompts hit the prompt cache. Run 1 is the realistic per-review cost.

### 5. What is left for AI after the deterministic steps (D12)

| | Hits |
|---|---|
| In-scope code hits | 1,036 (805 real per LSP) |
| Accepted as unambiguous | 164 |
| Settled by import-path resolution | 144 |
| Test-file hits collapsed to pairs | 274 hits → 49 pairs, of which 15 settled |
| **Left for LSP or AI** | **603 non-test hits + 34 test pairs** (83% of them in jsoup) |
| Receiver calls (`obj.name()`) among the 728 hits import resolution left open | 641 (88%) |

Import resolution settles bare names and module-attribute calls (`httpx.get`, `t.tax`) but not receiver calls. Those need types: a language server or the AI.

## Pipeline changes

These feed #15, #17, #16 and #43.
1. **Entity spans include adjacent leading comments** (#15). Use the tree-sitter `previousSibling` comment chain.
2. **Constructor chaining** (#17): for constructor roots, also search `super(` in direct subclasses and `this(` in the same class.
3. **Overloads are one changed entity** (#15, #17). Choosing between overloads is LSP territory, and the AI only needs to decide whether a call reaches the overload set.
4. **Import-path resolution** before LSP and AI (#17):
   - Resolve the hit file's import of the name, including relative TS paths, Python packages with `src/` and declared roots, and Java fully qualified imports.
   - Follow re-exports up to 3 levels.
   - A bare name not imported and not defined in the file can't be the target (TS and Python).
   - For constructor and `__init__` roots only call sites count; the first version counted `isinstance(x, C)` and return types, which cost 19 false `yes`.
5. **Test files at file level** (MVP spec D2): one edge per (test file, changed entity). One confirming hit settles it.
6. **LSP query strategy** (#16, #17):
   - **Readiness:** two identical answers, or `ServiceReady` for jdtls.
   - **Constructors:** query through the class, keeping only call sites.
   - **Overrides:** also query the overridden base methods, but keep only calls whose receiver type can reach the override. Without that filter, dispatch over-counts: 19 of the 28 dispatch-only positives here were wrong.
   - **Project health:** check the share of unresolved imports first. Treat an LSP "not a reference" as a rejection only when the project resolves; otherwise leave it `possible`.
7. **AI context policy** (#43, #22):
   - **Context:** enclosing function plus imports, plus the same-name definitions list, plus **the receiver's declaration** and **the re-export line for alias hits**.
   - **Prompt:** state that type uses count for class roots.
   - **Batching:** 12 groups per call.
   - **Verdicts:** keep `unsure` as `possible`.
   - **Safety cap:** at most 1,000 decisions per review; beyond that, mark the rest "not adjudicated". The largest PR here needed 528.
8. **AI is a fallback.** When a healthy language server is available, steps 1–6 decide nearly everything, and AI is only needed for languages or projects without one.

## Gaps and caveats

- **Ground truth is LSP plus a hand audit of disagreements.** Agreements between the model and LSP were not checked by hand. Dispatch ground truth over-approximates, as shown.
- **One model:** Sonnet 5.5 through `claude -p`. In the product, the user's running agent makes these calls (spec D8), so cost and latency depend on that agent and model.
- **Six PRs, one per shape, mostly well-structured libraries.** No monorepo, no generated code, no mixed-language PR.
- **The Python dependencies** were installed with `pip --target` in Docker. Java ran in Docker because the host has no JDK.
- **Base-side analysis** (removed calls) was limited to marking changed head entities. Deleted entities were not searched (2 in gson).
- **Linux only,** as in #4.

## Reproduction

Harness: scripts in a local scratch directory (`~/.cache/bcr-spike-42`), not committed.
- `analyze.mjs`: hunks, candidates, import resolution, LSP
- `stats.mjs`
- `ai.mjs`
- `eval.mjs`

```bash
npm i web-tree-sitter@0.27.1 tree-sitter-typescript@0.23.2 tree-sitter-javascript@0.25.0 \
      tree-sitter-python@0.25.0 tree-sitter-java@0.23.5 typescript-language-server@6.0.2 typescript@5.9.3 pyright@1.1.414
# jdtls image: FROM eclipse-temurin:25-jdk + maven + jdt-language-server-1.62.0-202610131109.tar.gz
# PRs (base -> head):
#   date-fns 60a29b2ecbb03cbcf75c9492e92f01d4e22cff43 -> 7f352cf1ba9cd50a1591a954a114ff64b3b6bf7c  (npm ci --ignore-scripts)
#   hono     b1335f9fb296cfa4b947367bbad0512c7739c5f5 -> efc8a461c0ed9164e7811cb40b593c7eec6f313e  (yarn install --ignore-scripts)
#   httpx    b471f01d668b9ef730e8843531b07b1c21b74c47 -> f8981f3d124f9b8db9073fd5c8afa11acb55a738  (pip --target .deps httpcore anyio …)
#   click    8a47580a00f3404e7071b9ecfec3692a1e18309f -> 4ece17a107d7b2e8bc3bd14356c2b53038fe41cf  (pyright extraPaths: src)
#   gson     286843d4a90a4690e5e1f438c944569b3fbfb1d2 -> 8526dbd2f0a7e61d5fbcc5caa163f2352fb0ddc0  (mvn dependency:go-offline -Denforcer.skip)
#   jsoup    969cb7865bddb3e8cc36a0054c65e2f964b3d2c8 -> af7999df5214d20175e58de6ff11f8ec4d520efe
# AI: claude -p --model claude-sonnet-5-5 --tools "" --system-prompt <below> --strict-mcp-config \
#       --setting-sources "" --no-session-persistence --output-format json
```

### AI prompt (example from the fixture)

System prompt:
```
You classify code-search hits for a code-review tool. A function, method or class was changed in a pull request. Text search found its name in other places. For each hit, decide whether that occurrence of the name refers to THE CHANGED ENTITY (a call, a reference, a method call that can dispatch to it, or a use through an alias/re-export), or to something else with the same name (another class's method, a different function, a local variable, a library API).
Rules:
- Judge only from the code shown. Do not invent facts. If the receiver type or import cannot be determined, answer "unsure".
- "yes" also covers dynamic dispatch: a call on a base-class/interface-typed receiver that can reach the changed override.
- Output ONLY a JSON array, one object per hit id: {"id": "...", "verdict": "yes"|"no"|"unsure", "via": "direct"|"dispatch"|"alias"|null, "reason": "<= 20 words", "line": <cited line number>}
```

User prompt (first 2 of 4 groups):
````
## Changed entity
File: src/price.ts
Entity: function formatPrice
Signature at head:
  function formatPrice(amount: number, currency: string): string
Signature at base:
  function formatPrice(amount: number): string
Other definitions with the same name in this repo (NOT the changed entity):
  - src/fmt.ts::Fmt.formatPrice (method)
  - src/legacy/price.ts::formatPrice (function)

## Hits

### src/checkout.ts — function checkoutSummary
Imports:
    1| import { formatPrice } from "./price";
```
      3| export function checkoutSummary(total: number): string {
>>    4|   return "Checkout: " + formatPrice(total, "USD");
      5| }
```
Hit ids: h1 = line 4 col 24

### src/invoice.ts — function invoiceSummary
…
Return the JSON array for ids: h1, h2, h3, h4
````

Response (run 1):
```json
[{"id":"h1","verdict":"yes","via":"direct","reason":"formatPrice imported from ./price and called directly.","line":4},
 {"id":"h2","verdict":"yes","via":"direct","reason":"formatPrice imported from ./price and called directly.","line":4},
 {"id":"h3","verdict":"yes","via":"direct","reason":"formatPrice imported from ./price and called directly.","line":4},
 {"id":"h4","verdict":"unsure","via":null,"reason":"fmt comes from ./reexport, whose contents are not shown; cannot confirm it aliases price.formatPrice.","line":4}]
```

`h4` shows the context-policy gap that change 7 fixes: the re-export line isn't shown.

## #43 results: the AI step as built

**Date:** 2026-10-20 · **Issue:** #43 · **Model:** `claude-sonnet-5-5` (plus one `claude-haiku-5-5` smoke run)

#43 built the AI step this spike recommended (step 7, with the context policy from [Pipeline changes](#pipeline-changes) item 7), and ran it the way the product does. The agent runs the whole skill: `generate --no-lsp`, `planner-input.md`, the `candidates/batch-<n>.md` files, and a validated `plan.json` with its `edgeVerdicts`. Unlike the spike's bare `claude -p` calls, the cost below includes grouping and planning the whole change, not just the verdicts.

Ground truth is a language server:
- on the fixtures, each fixture's `withLsp` facts;
- on the pull requests, `generate` with servers (typescript-language-server 6.0.2, pyright 1.1.414, jdtls 1.62 in Docker), on the same snapshot.

`npm run score:adjudication` scores the edges the batches asked about. Edges the server leaves `possible` have no truth and are not scored.

### Fixtures (`npm run eval`, `--runs 3`)

| Fixture | Model | Runs | Asked | Yes ✓/✗ | No ✓/✗ | Unsure | Precision | Recall | Identical | Cost |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| signature | Haiku | 1 | 2 | 0/0 | 2/0 | 0 | – | – | 2/2 | $0.009 |
| signature | Sonnet | 3 | 6 | 0/0 | 6/0 | 0 | – | – | 2/2 | $0.353 |
| interface-impl | Sonnet | 3 | 24 | 15/0 | 9/0 | 0 | 100% | 100% | 8/8 | $0.408 |
| same-name | Sonnet | 3 | 9 | 3/0 | 6/0 | 0 | 100% | 100% | 3/3 | $0.306 |
| override-dispatch | Sonnet | 3 | 3 | 3/0 | 0/0 | 0 | 100% | 100% | 1/1 | $0.248 |
| override-dispatch-python | Sonnet | 3 | 3 | 3/0 | 0/0 | 0 | 100% | 100% | 1/1 | $0.248 |
| **Total** | | 16 | 47 | 24/0 | 23/0 | 0 | **100%** | **100%** | **17/17, no flips** | **$1.57** |

Only these five fixtures have candidates. On the rest, import resolution or the unambiguous rule settles every `possible` edge.

### #42's pull requests (one Sonnet run each)

The same base and head commits as above, staged as a local change. HEAD is the base, the index is the head, and installed dependencies are excluded. The servers can then resolve the project.

| PR | Edges (no LSP) | Settled without AI | Asked | Scored | Yes ✓/✗ | No ✓/✗ | Unsure | Cost | Tokens in / out |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| date-fns | 11 | 10 | 1 | 1 | 0/0 | 1/0 | 0 | $0.167 | 154k / 3.9k |
| hono¹ | 21 | 15 | 6 | 6 | 6/0 | 0/0 | 0 | $0.177 | 151k / 5.1k |
| httpx | 20 | 18 | 2 | 2 | 0/0 | 2/0 | 0 | $0.203 | 131k / 3.3k |
| click | 40 | 10 | 30 | 27 | 23/0 | 2/**2** | 0 | $0.433 | 568k / 13.2k |
| gson | 19 | 15 | 4 | 4 | 4/0 | 0/0 | 0 | $0.198 | 131k / 2.7k |
| jsoup | 304 | 98 | 206 | 134 | 74/**3** | 41/**16** | 0 | $1.460 | 2.13M / 52.2k |
| **Total, raw** | 415 | 166 | **249** | 174 | 107/3 | 46/18 | 0 | **$2.64** | |

¹ Run after #93 fixed its parse error (see "hono: no edges" below), as a `--range b1335f9..efc8a46` target rather than a staged local change, so no dependencies were installed. The server still answered (`ok` on both sides) and verified all 21 edges.

Raw scores against the servers: 97.3% precision, 85.6% recall, 14.4% false rejections. Without hono, as first run: 97.1%, 84.9%, 15.1%.

**Audit.** As in the spike, every disagreement was checked by hand.
- **The 3 jsoup "false accepts" are correct.**
  - The target, `QuietAppendable.append`, is an overload set and therefore one changed entity (#15, [Pipeline changes](#pipeline-changes) item 3).
  - The calls were `accum.append(' ')` and `sb.append(chars, 0, 2)`, which reach the `char` and `char[]` overloads.
  - The server was asked about the first overload only, so it "rejected" them. That is a gap in the LSP query: it should ask every member of an overload set. It is not an AI error.
- **2 click and 15 jsoup false rejections were right about the code they were shown, but the batch left out the evidence that makes the edge real.** Both are context gaps in the AI step, not reasoning errors.
  - **click (2):** both are test-file edges to two nested `cli` functions in `tests/test_basic.py`. The graph keeps one hit per side for a test-file edge (D2), here line 421, and the batch showed only that hit. It calls a different test's `cli`. The real calls, at lines 452 and 476, were never shown.
  - **jsoup (15):** all are edges to `QuietAppendableTest.brokenAppender.append`, an anonymous `java.lang.Appendable` in a test. On the old side, every caller wrote to an `Appendable accum`, so each call can dispatch to the stub, and the server confirms the old-side hits. On the new side, `accum` is a `QuietAppendable`, which is not an `Appendable`, and the server agrees nothing there reaches the stub. The batch shows only the new side when an edge has new-side hits.
- **1 jsoup false rejection is a real AI error.** In `QuietAppendable.BaseAppendable.append`, `a.append(csq)` is on a `java.lang.Appendable` field, so it can dispatch to the test's anonymous `Appendable`, which the test wraps on purpose. The model's reason was "the test's anonymous Appendable is not involved". The batch also didn't show that the target sits in `new Appendable() { … }`, because the class header we show only covers named classes.

| | Precision | Recall | False rejections | Unsure |
|---|--:|--:|--:|--:|
| #42 baseline (Sonnet, bare calls, 636 decisions) | 100% | 97.2% | 0.5% | 1.9% |
| #43 raw against the servers (168 scored) | 97.1% | 84.9% | 15.1% | 0% |
| **#43 audited, by edge** (104 real accepted, 0 wrong, 18 real missed) | **100%** | **85.2%** | **14.8%** | 0% |
| #43 audited, judged on the code shown (17 context gaps counted correct) | 100% | 99.0% | 1.0% | 0% |

The model behaves as well as in the spike: 0 audited false accepts and 1 audited reasoning error in 168, with no `unsure`. What falls short is what the batch shows: 17 of the 18 missed real edges are context gaps. By edge, recall is 85.2% against the spike's 97.2%.

**Fixes, for follow-up issues:**
1. **Show the old side too** when an edge has hits on both sides and the code around them differs, or ask about each side. This would cover the 15 jsoup misses. The truth there is technically right, but it is the kind of over-count #42 warned about: a JDK interface reaching a test stub. Whether such old-side-only dispatch edges matter to a reviewer is worth deciding at the same time.
   #94 did this. When an edge's old-side receiver is declared differently from the new side's (jsoup's `Appendable accum` and `QuietAppendable accum`), its group also shows the old side's code and hits, and the edge is `yes` if either side uses the target. Such edges are shown like any other: they are real on the old side. jsoup has not been re-scored yet; that is a live run.
2. **Keep up to 3 hits per side for a test-file edge** in the evidence (#42's policy), not 1, so the batch can show them. This would cover the 2 click misses.
   #95 did this. The first 3 in file order would still all be line 421's test, so hits inside an entity that declares the target (the test whose nested `cli` it is) come before the rest. `generate --no-lsp` on click now shows lines 452, 456 and 463 for one edge and 421, 476 and 481 for the other. The test-file windows also show the `def test_…` line each hit is in. Batch 2 grew from about 7.9k to 10.2k characters; nothing else changed.
3. **Show the `new X() {` line for a method of an anonymous class**, and say in the dispatch rule that an implementation defined in a test or an anonymous class counts too. This would cover the 1 reasoning error. The prompt was not changed in #43.
   #96 did the first half. A changed method of an anonymous class now shows the line its class starts on, `new X() {` in Java or `class … {` for a TypeScript or JavaScript class expression, where a named class shows its header. The batch rules now also say that an implementation counts wherever it is defined, in a test or an anonymous class too. jsoup has not been re-scored yet; that is a live run.
4. **Ask the server about every member of an overload set** (#16/#17). The 3 wrong truths came from asking about only the first.
   #97 did this. Each member is asked about at its own name and the answers are merged. jsoup's truth has not been regenerated yet; that needs jdtls.

**Cost and volume.**
- **Decisions:** 249 were asked, against the spike's 636, because import resolution and the unambiguous rule now settle more edges before the AI step. On jsoup, 4 of its 98 settled edges are ones the server rejects; that is an import-resolution precision note.
- **Cost:** $2.64 for the six pull requests (hono's $0.18 run came later, with #93) and $1.57 for the fixtures, $4.21 in all. jsoup was $1.46: 6 batches, about 50k tokens of batch input on top of a 24k planner input.
- **Comparison with the spike's $1.59:** not like for like. These are whole skill runs with tool turns and cached context, and they plan the change as well as judge it.
- **Consistency:** run-to-run consistency was measured on the fixtures only (17/17 identical, no yes↔no flips). Each pull request ran once.

**hono: no edges.** The spike found 27 items there. Here, `src/context.ts` is skipped with `parse-error`, so it has no entities, so it gets no candidates. The structural analyzer (#15) treats a tree-sitter tree with errors as unparseable. A partial parse, keeping the entities outside the error regions, would recover most of this. This is a recall gap in candidate search, not in the AI step.

#93 fixed it. The errors are a grammar gap, not bad code: `tree-sitter-typescript` 0.23.2 cannot parse a generic call signature (`<T>(…): R`) that follows another member on a new line with no `;` ([upstream #335](https://github.com/tree-sitter/tree-sitter-typescript/issues/335)), as in hono's `Get`, `Set`, `TextRespond`, `JSONRespond` and `HTMLRespond`. The analyzer now keeps the entities outside the error regions and marks the file `partialParse`. `generate --no-lsp` on the same range then finds 21 possible edges, among them `Context.text/json/html` calling `#newResponse`, referencing `ResponseInit` and `ResponseOrInit`, and called from `src/types.test.ts`; 6 go to the caller batch. The three changed hunks inside `TextRespond`, `JSONRespond` and `HTMLRespond` stay on the file node.

The whole skill then ran once on Sonnet with a $0.50 cap (the hono row above): 10 turns, $0.177, and `validate` passed on the first try. It accepted all 6 batch edges (`Context.text/json/html` → `#newResponse`, and `src/types.test.ts` → `Context.text/json/html`), telling `c.text` apart from `c.req.text` and `c.html` from the `html` helper. typescript-language-server 6.0.2 verifies all 21 edges, so precision and recall are both 100% on 6 of 6. The audited figures above don't include hono; adding its 6 correct accepts gives 100% precision and 85.9% recall by edge. Two turns were wasted on harness details: the agent read `references/render-workflow.md`, which the eval does not install (#121), and Claude Code's Bash check refused writing `plan.json` with a heredoc, so it used Write instead.

## Post-MVP note

With a healthy language server, finding *unchanged* callers repo-wide is cheap (one `references` query per changed entity, about 1.5 s) and accurate. A post-MVP option for #2 is to show unchanged callers only when they are LSP-verified, and say they're unavailable otherwise. The AI fallback does not scale to that volume (see [Recommendation](#recommendation)).
