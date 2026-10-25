# Planner evaluation on the fixture portfolio

**Status:** Done. Round 2 passes on every fixture · **Date:** 2026-10-21 · **Issue:** #26 (part of #1, Milestone M2)
**Refs:** design reference §17.3 (Milestone 2 acceptance focus), §13.5 (heterogeneous edits) · [MVP spec](../mvp-spec.md) M2 · [fixture portfolio](../../test/fixtures/README.md) · [skill](../../skills/better-code-review/SKILL.md)

## Summary

**Round 2 passes on all five fixtures.** It ran on the current skill: #43's candidate adjudication, plus prompt iteration 1.
- **Sonnet:** every automated check passes on all five fixtures, and every manual criterion is met.
- **Haiku, on `signature`:** 8/8 automated. It meets every manual criterion, with one weaker grouping, noted below.
- **Cost:** $0.44 for the six runs, at a $0.50 cap per run.
- **Effect of iteration 1:** it fixed the one real failure from round 1, the same-name edits homed with the callers on `signature`.

## Summary of round 1

Round 1 ran on the skill as it was before #43. Its recordings went stale when #43 and prompt iteration 1 changed the skill, and were deleted. Their results are kept here. [Round 2](#round-2) re-runs the same fixtures on the current skill.


`claude-sonnet-5-5`, following the skill with no language server, wrote a valid plan on all five fixtures. It invented nothing and judged every `possible` edge correctly. It also put each contract before its callers and read the feature flow in order.

| Fixture | Case | Automated | Manual | Result |
|---|---|---|---|---|
| `signature` | Signature propagation | 6/8 | M1 fail | **Fail** |
| `ten-callers` | Signature propagation, wide | 4/4 | Pass | **Pass** |
| `feature-flow` | New-feature flow | 4/4 | Pass | **Pass** |
| `independent-roots` | Unrelated changes | 6/6 | Pass | **Pass** |
| `tests-and-config` | Unrelated changes | 5/6 | Pass | **Fail** (the check is likely too strict, see below) |

The two failures:
- **`signature`:** the same-name edits `viaMethod` and `use_calc` are homed in the callers groups. The plan's own verdicts say they are not callers.
- **`tests-and-config`:** the plan splits the three config files into three groups by purpose. The check asked for one group, but the split reads better. The check has since been relaxed (see [Decisions](#decisions)), and the plan would pass it.

Cost: **$0.49** for the five runs. The cap was $0.50 per run, so $2.50 at worst. Two of the first five runs hit the account's session limit and were run again after it reset; they cost $0.01. Input was 60–140k tokens a run, mostly cache reads.

## Question

Given the deterministic graph of a fixture, does the agent following the skill (#25) write a `plan.json` that a reviewer can use? §17.3 names four things to check:
1. **Central vs supporting organization.** The roots of the change are their own groups. What follows from them (callers, tests, config, unrelated edits) is grouped apart from them.
2. **Useful ordering.** `groupOrder` follows the reading order the skill describes: a contract before its callers, and a feature from entry point to persistence. Then tests, then config and unrelated edits.
3. **No invented code nodes.** The plan names only IDs from the input, adds no code edges and holds no code text.
4. **Transparent confidence and provenance.** Verdicts on `possible` edges stay verdicts, each with a reason and a cited line. The plan's text never presents a `possible` edge as proven.

## Fixtures

The issue's four cases, mapped to the TypeScript-only portfolio (#9):

| Case | Fixture | What a good plan does |
|---|---|---|
| Signature propagation | `signature` | `formatPrice` contract, then its four callers. `tax` contract, then its two callers. `legacyLabel`, `viaMethod` and `use_calc` are same-name edits, not callers, and are grouped apart. `config.json` is an unrelated edit |
| Signature propagation, wide | `ten-callers` | `parseDate` contract, then its ten callers, in one group or split into children |
| New-feature flow | `feature-flow` | Route (`postOrder`), then service (`createOrder`), then persistence (`insertOrder`), then the test |
| Unrelated changes (§13.5) | `independent-roots` | Three groups with no forced link between them |
| Unrelated changes (§13.5) | `tests-and-config` | Tests apart from configuration. No code group, since no code under test changed |

Only these five were run in rounds 1 and 2. The other fixtures got only the general checks below until #101, which gave plan facts to every fixture with a clear reading order or separation (see [the fixture facts](#automated-testaiscorets)). No live run has scored those facts yet. Four fixtures have none, and say why in their source:
- `unchanged-caller`: one node.
- `override-dispatch` and `override-dispatch-python`: neither edit changes what the other relies on.
- `dynamic-calls`: the three nodes are linked only through names in strings, so a plan may join them or keep them apart.

### Decisions

- **Each contract before its own callers.** When a change has several roots, the plan doesn't have to lead with any particular one. On `signature`, either `formatPrice` or `tax` may come first, as long as each is read before its callers.
- **Config may be split by purpose.** On `tests-and-config`, the config files don't have to share a group, as long as they are apart from the tests. One group per purpose (test tooling, CI, compiler settings) is the §13.5 behaviour we want. This was decided after round 1.
- **Feature flow from the entry point.** `feature-flow` is read route → service → persistence → test, the order the skill gives for implementation flow. Note that this is the reverse of "callee first", which the fallback plan uses (see [Baseline](#baseline-the-fallback-plan)).

### Out of scope

- **Mixed-language changes.** These are covered in depth by #77, which adds Python, Java, Go and multi-language fixtures, including a cross-language HTTP/API change. Here the only mixed-language input is `signature`, whose TypeScript and Python halves share no code. Its plan facts keep the two halves apart. A cross-language link, which only an agent can infer (D6), is not tested.
- **Codex CLI.** The MVP spec's M2 acceptance names Claude Code and Codex CLI. Codex is deferred until after v0.1, and the harness only drives `claude -p`.
- **Verdict accuracy.** Verdicts are counted here, but whether they are right is #43's measurement ([`candidate-adjudication.md`](candidate-adjudication.md)). In round 1 every verdict was right by inspection.
  - Since #43, the agent judges only the edges its candidate batches ask about. Edges settled by import resolution or the unambiguous rule get no verdict.
  - So in round 2, the eval's "verdicts on N/M possible edges" line could rightly show N below M.
  - Since #99, the line counts against the edges the batches ask about and lists the settled ones apart, e.g. `verdicts on 2/2 asked edges (yes 0, no 2, unsure 0); 6 settled without asking` on `signature`. The round 2 table below keeps the old `judged/possible` form.

## Criteria

A fixture **passes** when every automated check passes and every manual criterion is met.

### Automated: `test/ai/score.ts`

`npm run eval:live` runs these on every live run. `replay.test.ts` runs them on every committed recording, against its list of known failures (`KNOWN_FAILS`).

| Check | Criterion it covers | Passes when |
|---|---|---|
| `valid` | 3, 4 | The plan validator (#23) accepts it: only known node, edge and hunk IDs, no new code edges, no `verified` verdicts, no code text fields, cited lines exist |
| `agent` | | `origin` is `agent`: the repair loop didn't end in the fallback plan |
| `homed` | 1 | No node is left in Ungrouped. Every node in these fixtures can be placed |
| `order …` | 2 | Each step of the fixture's reading chain is read before the next (`plan.order` in the fixture) |
| `together …` | 1 | The named nodes share a home group (`plan.together`) |
| `apart …` | 1, §13.5 | The named sets share no home group (`plan.apart`) |

The fixture facts:

| Fixture | Facts |
|---|---|
| `signature` | Order: `formatPrice` → its 4 callers, and `tax` → `order_total`, `refund`. Apart: the TypeScript propagation, the Python propagation and the same-name edits |
| `ten-callers` | Order: `parseDate` → its 10 callers |
| `feature-flow` | Order: `postOrder` → `createOrder` → `insertOrder` → `createOrder.assigns an id` |
| `independent-roots` | Apart: `cartTotal`, `logLevel`, `welcomeMessage` |
| `tests-and-config` | Together: the 2 test nodes. Apart: the test nodes and the 3 config files. Round 1 also required the 3 config files to share a group |
| `malicious-content` | Apart: `greet` and `README.md` (#35) |
| `removed-calls` (#101) | Apart: the notification moving to a queue (`notifyByEmail`, `src/queue.ts`, `enqueueNotification`, `placeOrder`) and the refund no longer auditing (`audit`, `refundOrder`) |
| `rename-move` (#101) | Order: `toSlug` → `src/urls.ts`, `postUrl`. The pure move of `clamp.ts` is free |
| `interface-impl` (#101) | Order: `PaymentGateway` → every implementation and caller |
| `same-name` (#101) | Apart: the three `validate`s. Their callers are free, so the three message changes may share a group |
| `unsupported-binary` (#101) | Apart: the port change (`cmd/server/main.go`, `docs/guide.md`, `banner`) and `scripts/deploy.rb` |
| `large-generated` (#101) | Order: `log` → all 120 jobs, including the 20 over the fan-out cap. Apart: the 30 pipeline steps and the logging change |

### Manual: read each plan

| # | Criterion | Pass | Fail |
|---|---|---|---|
| M1 | Central vs supporting | Group titles name the roots. Supporting groups say what they follow from. Unrelated edits are labelled as looking unrelated | A root is buried in a supporting group, or unrelated edits are described or grouped as part of the main change |
| M2 | Ordering | A reviewer reading groups in order never meets a caller before its contract, or a layer before the one that calls it | The order is file order or arbitrary where a better one is obvious |
| M3 | Grounded text | Summary and descriptions mention only code in the change, say what to check rather than claiming correctness, and quote no code | A claim the diff doesn't support, a "this is correct" or "complete", or code copied into text |
| M4 | Provenance | Text calls `possible` edges candidates or the agent's judgement. Each verdict's `citedLine` is the line that decides it | Text says a relationship is verified or proven. A cited line that doesn't show what the reason says |
| M5 | Size | 2 to 7 top-level groups (the skill's target), and no group of one unless it is a root | One group per node, or one group for everything |

## Baseline: the fallback plan

The deterministic plan (`generate` with no agent, #24), scored by the same checks at no cost. It is the bar an agent plan has to beat. It fails `agent` by definition; the table counts the other checks.

During #26 the fallback plan changed in two ways:
- Within a group, each callee now comes before its callers.
- A code node with no edge and no other change in its file is now a group of its own. Lone files (config, docs, binaries) share an "Other changed files" group, last. Before, both went to Ungrouped.

| Fixture | Before (`agent` aside) | After (`agent` aside) | Still failing |
|---|---|---|---|
| `signature` | 2/7 | 5/7 | `apart` twice: the same-name edits share clusters with the callers, since a `possible` edge joins them |
| `ten-callers` | 3/3 | 3/3 | |
| `feature-flow` | 2/3 | 2/3 | `order`: callee first reads persistence → service → route, the reverse of the decided flow |
| `independent-roots` | 1/5 | 5/5 | |
| `tests-and-config` | 4/5 | 5/5 | |

The facts #101 added, on the fallback plan as it is now:

| Fixture | `agent` aside | Failing |
|---|---|---|
| `removed-calls` | 2/3 | `apart`: both changes touch `src/orders.ts`, so one cluster holds them |
| `rename-move` | 3/3 | |
| `interface-impl` | 3/3 | |
| `same-name` | 2/5 | `apart` three times: the receiver call's `possible` edges join the three `validate`s in one cluster, as on `signature` |
| `unsupported-binary` | 2/3 | `apart`: `main.go`, `guide.md` and `deploy.rb` are lone files, which share "Other changed files" |
| `large-generated` | 3/4 | `order`: `job100` to `job119` have no edge to `log` (the cap), so callee first doesn't place them after it |

Every fixture in the portfolio now passes `homed` with the fallback plan.

## Runs

| Date | Command | Model | Fixtures | Cap per run | Cost | Notes |
|---|---|---|---|---|---|---|
| 2026-10-20 | `npm run eval` (smoke, #25) | `claude-haiku-5-5` | `signature` | $0.25 | $0.0091 | Before #26. Passes all 8 checks on replay |
| 2026-10-20 | `npm run eval -- --model claude-sonnet-5-5 --max-budget-usd 0.5 --fixture signature --fixture ten-callers --fixture feature-flow --fixture independent-roots --fixture tests-and-config` | `claude-sonnet-5-5` | All five | $0.50 | $0.3406 | `independent-roots` and `tests-and-config` hit the session usage limit (HTTP 429) after 2 turns and 0 turns |
| 2026-10-20 | The same command, with only `--fixture independent-roots --fixture tests-and-config` | `claude-sonnet-5-5` | The two cut off | $0.50 | $0.1518 | After the limit reset |

## Results, round 1 (skill before #43)

Automated is `passed/total`. Verdicts are `judged/possible`.

| Fixture | Model | Automated | M1 | M2 | M3 | M4 | M5 | Verdicts | Result |
|---|---|---|---|---|---|---|---|---|---|
| `signature` | `claude-haiku-5-5` | 8/8 | Pass | Pass | Pass | Pass | Pass (5 groups) | 8/8 (6 yes, 2 no) | Pass |
| `signature` | `claude-sonnet-5-5` | 6/8 | **Fail** | Pass | Pass | Pass | Pass (5 groups) | 8/8 (6 yes, 2 no) | **Fail** |
| `ten-callers` | `claude-sonnet-5-5` | 4/4 | Pass | Pass | Pass | Pass | Pass (2 groups) | 10/10 (10 yes) | Pass |
| `feature-flow` | `claude-sonnet-5-5` | 4/4 | Pass | Pass | Pass | Pass | Pass (4 groups) | 7/7 (7 yes) | Pass |
| `independent-roots` | `claude-sonnet-5-5` | 6/6 | Pass | Pass | Pass | Pass | Pass (3 roots) | none possible | Pass |
| `tests-and-config` | `claude-sonnet-5-5` | 5/6 | Pass | Pass | Pass | Pass | Pass (4 groups) | none possible | **Fail** (automated) |

Workflow notes, from the transcripts in `.cache/eval/transcripts/`:
- Each run took 6 to 10 tool calls.
- In `feature-flow` and `independent-roots`, the agent first tried to write `plan.json` with a shell heredoc. Claude Code's permission check refused it ("brace with quote character"), and the agent used `Write` instead. That costs a turn but does no harm. SKILL.md step 3 now says to write `plan.json` with the file-writing tool (#100).

Round 1 committed its failing recordings for review, with their failed checks listed in `KNOWN_FAILS` in `replay.test.ts`. They were deleted as stale before round 2.

### Per fixture

**`signature` (Sonnet): fail.** Groups, in order:
1. formatPrice gains a currency parameter
2. Callers pass 'USD' (5 nodes)
3. tax gains an optional rate
4. Callers pass a 0.2 rate (3 nodes)
5. Config currency and legacy label

- **Good:**
  - Each contract comes first, and both read as roots.
  - All 8 verdicts are right. `viaMethod` → `formatPrice` and `use_calc` → `tax` are `no`, each citing the receiver call.
  - It notices that `config.json` now says EUR while the callers hardcode 'USD'. It adds that as a `logically-related` inferred relationship rather than a code edge, which is what D6 asks for.
  - `legacyLabel` and the config change are labelled as looking unrelated.
- **Fail (M1, `apart` ×2):** `viaMethod` is homed in "Callers pass 'USD'" and `use_calc` in "Callers pass a 0.2 rate". The descriptions add that each "calls a different" method, but a reviewer skimming the titles is told they are callers. The groups follow the candidate edges, not the verdicts.
- **Comparison:** Haiku, on the same input, put all three same-name edits in its unrelated group and passes.

**`ten-callers`: pass.** Groups, in order:
1. parseDate gains a zone parameter
2. Reports pass 'UTC' (10 nodes)

The summary reminds the reviewer that unchanged callers were not analysed (D12). The contract's description raises a real question: what happens for zones other than UTC?

**`feature-flow`: pass.** Groups, in order:
1. POST /orders route registered (`registerRoutes`, `postOrder` and their modules)
2. createOrder service
3. In-memory order storage
4. createOrder test

The order is exactly the decided flow. Each description ends with a concrete check:
- the route body isn't validated;
- the service doesn't validate `sku`;
- ids come from the array length;
- the test misses the invalid-quantity path.

All 7 edges are `yes`, including the type references, with `via: direct`.

**`independent-roots`: pass.** There are three one-node groups, each a root, and no forced link: the summary says "No code edges link them". `welcomeMessage` is labelled as looking unrelated.

**`tests-and-config`: fail on the automated check; the plan itself reads well.** Groups, in order:
1. New formatPrice rounding test
2. Test script and package version (`package.json`)
3. CI uses Node 22 (`ci.yml`)
4. Stricter TypeScript indexing (`tsconfig.json`)

- **The fail:** the plan splits the config by purpose and says the edits are "mostly independent". It links two of them with a `logically-related` relationship: CI runs the test script.
- **Why I count it as a pass on M1:** this is the §13.5 behaviour we want, and arguably better than one "configuration" group. The `together` fact for the three config files is probably too strict.
- **Other notes:** the test group comes first, and the 0.125 rounding case is flagged as a floating-point edge.

## Prompt iterations

A change to `SKILL.md` or a reference makes every recording stale (input hash, #85). So each iteration is re-run on every fixture it could affect, and each re-run needs approval.

| # | Change | Why (which fail) | Fixtures to re-run | Effect |
|---|---|---|---|---|
| 1 | In `analysis-workflow.md` § Grouping, step 2: "A node whose only edges to a root you judged `no` is not its caller: put it with the unrelated edits, not with that root's callers." | `signature` (Sonnet, round 1): same-name edits homed with callers | Round 2: all five on Sonnet, `signature` on Haiku | Fixed. Both models home the `no`-judged same-name edits with the unrelated edits. No fixture regressed |

Iteration 1 was made after #43 merged, on top of #43's new adjudication text. #43's change and this one both make every recording stale, so round 2 re-runs everything.

## Round 2

The skill after #43 (candidate batches and the adjudication text), plus iteration 1, with the relaxed `tests-and-config` fact. Both runs were made on 2026-10-21, at a $0.50 cap per run, from the worktree:

```
npm run eval -- --model claude-sonnet-5-5 --max-budget-usd 0.5 --fixture signature --fixture ten-callers --fixture feature-flow --fixture independent-roots --fixture tests-and-config
npm run eval -- --model claude-haiku-5-5 --max-budget-usd 0.5 --fixture signature
```

Total cost: $0.44. Every plan passed `validate` the first time, in 6 to 9 tool calls. `KNOWN_FAILS` is empty.

Verdicts are `judged/possible`. Since #43, only the edges the candidate batches ask about get one. The rest are settled by import resolution or the unambiguous rule.

| Fixture | Model | Automated | M1 | M2 | M3 | M4 | M5 | Verdicts | Cost | Result |
|---|---|---|---|---|---|---|---|---|---|---|
| `signature` | `claude-sonnet-5-5` | 8/8 | Pass | Pass | Pass | Pass | Pass (5 groups) | 2/8 (2 no) | $0.124 | **Pass** |
| `ten-callers` | `claude-sonnet-5-5` | 4/4 | Pass | Pass | Pass | Pass | Pass (2 groups) | 0/10 | $0.081 | **Pass** |
| `feature-flow` | `claude-sonnet-5-5` | 4/4 | Pass | Pass | Pass | Pass | Pass (4 groups) | 0/7 | $0.080 | **Pass** |
| `independent-roots` | `claude-sonnet-5-5` | 6/6 | Pass | Pass | Pass | Pass | Pass (3 roots) | none possible | $0.071 | **Pass** |
| `tests-and-config` | `claude-sonnet-5-5` | 5/5 | Pass | Pass | Pass | Pass | Pass (4 groups) | none possible | $0.075 | **Pass** |
| `signature` | `claude-haiku-5-5` | 8/8 | Pass, see note | Pass | Pass | Pass | Pass (4 groups) | 2/8 (2 no) | $0.008 | **Pass** |

### Per fixture, round 2

**`signature` (Sonnet): pass.** Groups, in order:
1. formatPrice gains a currency parameter
2. TypeScript callers pass a currency (4 nodes)
3. tax gains a rate parameter
4. Python callers pass a rate (2 nodes)
5. Edits unrelated to the new parameters (`viaMethod`, `use_calc`, `legacyLabel`, `config.json`)

- **Iteration 1 worked.** The two same-name edits it judged `no` (`viaMethod`, `use_calc`) are now in the unrelated group, so the callers groups hold only real callers.
- The summary says outright that the other edits look unrelated.
- The EUR config change is still flagged as a `logically-related` inferred relationship, not a code edge.

**`signature` (Haiku): pass, with a weaker grouping.** Its four groups:
1. formatPrice contract
2. formatPrice callers
3. One "tax gains an optional rate parameter" group, holding `tax`, `order_total` and `refund`
4. The unrelated edits

- `tax` is listed first in its group, so the order checks pass, and the description names the callers. But the root isn't a group of its own. I count that as a pass on M1, since the title still names the root.
- Its descriptions are the most specific of any run. They say the same-name calls are "not callers", and ask whether the legacy `formatPrice` should change too.

**`ten-callers`: pass.** Groups:
1. parseDate gains a zone parameter
2. Reports pass 'UTC' (10 nodes)

The descriptions ask about non-UTC zones, input that already has an offset, and callers that may have been missed. All ten edges were settled without AI, by import resolution or the unambiguous rule, so no verdicts were needed. The same holds for `feature-flow`'s seven.

**`feature-flow`: pass.** Groups, in order: route, service, storage, tests, the decided flow. Each description ends with a concrete check: the unchecked body cast, the validation rule, id assignment and shared state, and the untested failure path.

**`independent-roots`: pass.** There are three single-node groups. The summary says the commit "has no single stated intent, so each change should be reviewed on its own", which is the §13.5 behaviour. The unrelated wording change is labelled "(looks unrelated)" in its title.

**`tests-and-config`: pass.** Groups:
1. The rounding test
2. Test script with coverage (`package.json`)
3. Node 22 in CI (`ci.yml`)
4. Stricter TypeScript (`tsconfig.json`)

This is the same split by purpose as round 1, which the relaxed fact now accepts. The test's floating-point edge case and the missing coverage provider are flagged as things to check.

## Conclusion

**M2 acceptance focus (§17.3): met.** Round 2, on the current skill with no language server, gives these results:
- **Central vs supporting (1):** met on every fixture, for both models. Haiku's one shared tax group is a weaker grouping, not a failure.
- **Useful ordering (2):** met on every fixture. Each contract comes before its callers, and the feature is read from route to storage to tests.
- **No invented nodes (3) and provenance (4):**
  - Every plan validated the first time.
  - Every verdict was right, with a real cited line.
  - Nothing was presented as `verified`.

Every recording is committed and passes its checks on replay. The remaining gaps are out of scope here: a cross-language fixture (#77), Codex CLI (after v0.1) and verdict accuracy on real PRs (#43's write-up).

Round 1, on the M2 acceptance focus (§17.3), with Sonnet and no language server:
- **No invented nodes (3) and provenance (4):** met on every fixture.
  - Every Sonnet plan passed `validate` the first time, with no repair round.
  - Verdicts were all right, each with a reason and a real cited line.
  - Nothing claimed `verified`.
- **Useful ordering (2):** met on every fixture.
- **Central vs supporting (1):** met except on `signature`. There, the grouping follows the candidate edges instead of the agent's own `no` verdicts. That is the one real weakness, and prompt iteration 1 targets it.
