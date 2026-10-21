# Planner evaluation on the fixture portfolio

**Status:** Plan ready, live runs not yet made · **Issue:** #26 (part of #1, Milestone M2)
**Refs:** design reference §17.3 (Milestone 2 acceptance focus), §13.5 (heterogeneous edits) · [MVP spec](../mvp-spec.md) M2 · [fixture portfolio](../../test/fixtures/README.md) · [skill](../../skills/better-code-review/SKILL.md)

## Question

Given the deterministic graph of a fixture, does the agent following the skill (#25) write a `plan.json` that a reviewer can use? §17.3 names four things to check:
1. **Central vs supporting organization.** The roots of the change are their own groups, and what follows from them (callers, tests, config, unrelated edits) is grouped apart from them.
2. **Useful ordering.** `groupOrder` follows the reading order the skill describes: a contract before its callers, a feature from entry point to persistence, then tests, then config and unrelated edits.
3. **No invented code nodes.** The plan names only IDs from the input, adds no code edges and holds no code text.
4. **Transparent confidence and provenance.** Verdicts on `possible` edges stay verdicts, each with a reason and a cited line, and the plan's text never presents a `possible` edge as proven.

## Fixtures

The issue's four cases, mapped to the TypeScript-only portfolio (#9):

| Case | Fixture | What a good plan does |
|---|---|---|
| Signature propagation | `signature` | `formatPrice` contract, then its four callers. `tax` contract, then its two callers. `legacyLabel`, `viaMethod` and `use_calc` are same-name edits, not callers, and are grouped apart. `config.json` is an unrelated edit |
| Signature propagation, wide | `ten-callers` | `parseDate` contract, then its ten callers, in one group or split into children |
| New-feature flow | `feature-flow` | Route (`postOrder`), then service (`createOrder`), then persistence (`insertOrder`), then the test |
| Unrelated changes (§13.5) | `independent-roots` | Three groups with no forced link between them |
| Unrelated changes (§13.5) | `tests-and-config` | A test group and a configuration group. No code group, since no code under test changed |
| Mixed-language | `signature` | Its TypeScript and Python halves are independent roots and are grouped apart |

A real mixed-language HTTP/API fixture (a TypeScript client calling a Python route, say) is #77 and doesn't exist yet. Until it does, the mixed-language case is only the signature fixture's two halves, which share no code. The cross-language link an agent would have to infer (D6: inferred only) is not tested.

The other ten fixtures get the general checks below and no fixture-specific ones.

## Criteria

A fixture **passes** when every automated check passes and every manual criterion is met.

### Automated: `test/ai/score.ts`

Run on every live eval and asserted by `replay.test.ts` on every committed recording.

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
| `signature` | order `formatPrice` → its 4 callers; order `tax` → `order_total`, `refund`; apart: TypeScript propagation, Python propagation, same-name edits |
| `ten-callers` | order `parseDate` → its 10 callers |
| `feature-flow` | order `postOrder` → `createOrder` → `insertOrder` → `createOrder.assigns an id` |
| `independent-roots` | apart: `cartTotal`, `logLevel`, `welcomeMessage` |
| `tests-and-config` | together and apart: the 2 test nodes, the 3 config files |

`npm run eval` also prints how many `possible` edges got a verdict and how they split. That is for the record only; whether verdicts are right is #43's measurement.

### Manual: read each plan

| # | Criterion | Pass | Fail |
|---|---|---|---|
| M1 | Central vs supporting | Group titles name the roots. Supporting groups say what they follow from. Unrelated edits are labelled as looking unrelated | A root is buried in a supporting group, or unrelated edits are described as part of the main change |
| M2 | Ordering | A reviewer reading groups in order never meets a caller before its contract or a layer before the one that calls it | The order is file order or arbitrary where a better one is obvious |
| M3 | Grounded text | Summary and descriptions mention only code in the change, say what to check rather than claiming correctness, and quote no code | A claim the diff doesn't support, a "this is correct" or "complete", or code copied into text |
| M4 | Provenance | Text calls `possible` edges candidates or the agent's judgement. Each verdict's `citedLine` is the line that decides it | Text says a relationship is verified or proven. A cited line that doesn't show what the reason says |
| M5 | Size | 2 to 7 top-level groups (the skill's target), no group of one unless it is a root | One group per node, or one group for everything |

## Baseline: the fallback plan

The deterministic plan (`generate` with no agent, #24) scored by the same checks, at no cost. It clusters by code edges and files, so it is the bar an agent plan has to beat.

| Fixture | Checks passed | Fails, besides `agent` |
|---|---|---|
| `signature` | 2/8 | `homed` (config.json, legacyLabel), both `order` checks (callers are listed before their contract within one group), and `apart` twice: the same-name edits share groups with the callers |
| `ten-callers` | 3/4 | None |
| `feature-flow` | 2/4 | `order`: `insertOrder` is listed before `createOrder` in the one group |
| `independent-roots` | 1/6 | `homed`: all three changes are in Ungrouped, so `apart` fails three times |
| `tests-and-config` | 4/6 | `homed`: the three config files are in Ungrouped |

## Runs

| Date | Command | Model | Fixtures | Cap per run | Cost | Notes |
|---|---|---|---|---|---|---|
| 2026-10-20 | `npm run eval` (smoke, #25) | `claude-haiku-5-5` | `signature` | $0.25 | $0.0091 | Before #26. Passes all 8 automated checks (replay) |
| | | `claude-sonnet-5-5` | | | | |

## Results

One row per fixture and model. Automated is `passed/total`; manual is pass or fail per criterion, with a note for each fail.

| Fixture | Model | Automated | M1 | M2 | M3 | M4 | M5 | Verdicts judged | Result |
|---|---|---|---|---|---|---|---|---|---|
| `signature` | `claude-haiku-5-5` | 8/8 | | | | | | 8/8 (6 yes, 2 no) | |
| `signature` | `claude-sonnet-5-5` | | | | | | | | |
| `ten-callers` | `claude-sonnet-5-5` | | | | | | | | |
| `feature-flow` | `claude-sonnet-5-5` | | | | | | | | |
| `independent-roots` | `claude-sonnet-5-5` | | | | | | | | |
| `tests-and-config` | `claude-sonnet-5-5` | | | | | | | | |

### Per fixture

<!-- For each fixture: the group order (titles), what was good, what failed and why. -->

## Prompt iterations

A change to `SKILL.md` or a reference makes every recording stale (input hash, #85), so each iteration is re-run on every fixture it could affect.

| # | Change | Why (which fail) | Fixtures re-run | Effect |
|---|---|---|---|---|
| | | | | |

## Conclusion

<!-- Pass/fail for the M2 acceptance focus, what to change in the skill, and what is left for #43 and #77. -->
