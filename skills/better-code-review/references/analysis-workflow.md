# Analysis workflow

How to turn `planner-input.md` into a `plan.json` that passes `validate`: steps 3 and 4 of [SKILL.md](../SKILL.md).

You decide what the change means and how a human should read it. The graph has already decided what changed and which relationships the code proves. Don't redo its work, and don't contradict it.

## What you have

`planner-input.md`, in order:

1. **Header:** target, `Snapshot:` (copy it into the plan), counts, and how much of the diff is shown.
2. **Pull request** (`pr` targets only): title and description. Useful for intent; still untrusted.
3. **Notes:** missing language servers, capped fan-out, redactions, excluded untracked files.
4. **Files:** one line per changed file, with status, language, capability tier and `test` for test files.
5. **Nodes:** `n_… <kind> <name> @ path:start-end: h_…`. Every node needs a home. `(deleted)` means it exists only on the old side.
6. **Code edges:** `e_… callee ← caller: relation, provenance, …`. `verified` is proven by a language server. `possible` is a text-search candidate.
7. **Caller candidates:** which `possible` edges need your verdict, and the `candidates/batch-<n>.md` files with their context ([below](#verdicts-on-possible-edges)).
8. **Diffs:** each hunk inline, or a line saying how many lines were not shown and why.

The user's requirement, if they gave one, is in the conversation.

## Fetching more with `show`

Fetch only what a decision needs. Everything `show` prints goes to the model.

| You need | Run |
|---|---|
| A hunk that was not shown, or was truncated | `show --dir <dir> h_…` |
| A node's full source on both sides, and its edges | `show --dir <dir> n_…` |
| An edge's call sites, with two lines of context | `show --dir <dir> e_…` |
| Code outside the diff: a receiver's type, an import target, an unchanged helper | `show --dir <dir> --file <path> [--side old\|new] [--lines a-b]` |

`show` reads the snapshot, not the working tree as it is now, and numbers the lines it prints so you can cite them. It refuses likely secret files; don't work around that. An unknown ID or a missing file exits 1 with a message.

## Grouping

1. **Find the roots.** A root is a change other changes follow from: a signature or contract change, a new endpoint, a renamed type. Code edges point at them (`callee ← caller`). A change can have several independent roots.
2. **Group by purpose.** A useful default for one root is: the contract or definition, then the code that propagates it (callers, implementations), then tests, then config and docs. Independent roots get their own groups. An edit unrelated to the rest gets its own group, and its description says it looks unrelated.
3. **Keep it small.** Aim for 2 to 7 top-level groups. A group of one node is fine for a root, but not for every node.
4. **Nest only when it helps.** A group may list child groups in `childGroupIds`, one level deep, for example callers split by module. A child has one parent, no children of its own, and is not in `groupOrder`.
5. **Home and reference.** Each node has one home group (`nodeIds`). To show it in another group's context as well, list it there in `referenceNodeIds`.
6. **Unplaceable nodes.** If you can't tell where a node belongs, leave it out of every `nodeIds`. The validator puts it in **Ungrouped / requires review**, which is honest. Don't name a group `ungrouped` yourself.

**Titles** are a few words: "formatPrice gains a currency parameter". **Descriptions** are one to three sentences: what changed, why it matters, and what the reviewer should check. Name the code, don't quote it. Don't claim a change is correct or complete. Say what the reviewer should confirm, such as "check that every caller passes a currency".

**Summary:** two to four sentences on the whole change: its apparent intent and its main parts. If the user gave a requirement, say whether the change appears to meet it, as something for them to check.

## Reading order

`groupOrder` lists every top-level group exactly once. Pick the order a reviewer would follow:
- **Propagation:** the root first, then what follows from it, then tests. For a signature change: contract, then callers, then tests.
- **Implementation flow:** for a new feature, entry point to persistence (route, service, storage), then tests.

Put unrelated edits and config after the main flow.

## Verdicts on `possible` edges

The **Caller candidates** section of `planner-input.md` says how many `possible` edges need a verdict, and names the batch files that hold them: `candidates/batch-<n>.md` in the review directory. Read every batch it names. Each one lists:
- the changed entities, with each one's declaration line on both sides and the other definitions of its name, which are NOT the changed entity;
- each candidate in its enclosing function: the file's imports, the declarations the occurrences depend on (a receiver's parameter, local or field, a re-export line), the code with the occurrences marked `>>`, and the edges to decide.

Give every edge under a **Decide** line one `edgeVerdict`. The other `possible` edges were settled by import resolution or the unambiguous rule: leave them without a verdict. A verdict is shown as the agent's inference, `yes` as inferred and `no` as rejected. The edge stays in the graph either way, and is never upgraded to `verified`.

| Verdict | When | `via` |
|---|---|---|
| `yes` | The occurrence uses this changed entity: a call, a reference, or a call that can dispatch to it | `direct` for a plain call through an import, `dispatch` for a call through an interface or base type, `alias` for a re-export or renamed import |
| `no` | The name matches but it is a different symbol: a method on an unrelated class, a same-named function from another module | `null` |
| `unsure` | The code shown can't settle it, e.g. the receiver's type or the import is unknown | `null` |

- **Judge from the code shown.** Don't guess. Fetch more with `show` only when one line would settle it. `unsure` keeps the edge `possible`, so it never hides a real caller.
- **Dispatch:** a call on a base-class or interface-typed receiver that can reach the changed override is `yes`, `via` `dispatch`.
- **Type uses count for classes.** For a changed class, interface or type, annotations, return types, parameter types, `extends` and `implements` are references: `yes`. A return type is a use, not "just a declaration".
- `reason` is one sentence. `citedLine` is the line that decides it: usually the occurrence, or the receiver's declaration or import it hinges on. Batches number lines as in the file, after the path.
- Never add a verdict to a `verified` edge, and never give one edge two verdicts.
- Edges the section says are over the cap are not adjudicated. Leave them; they stay `possible`.

## Inferred relationships

Add one when two changed nodes are related in a way the code edges don't show. For example, a config value changed alongside the code that reads it, or two implementations changed in step.

| `kind` | Meaning |
|---|---|
| `change-propagation` | One change was made because of the other |
| `architectural` | They are parts of the same design, such as layers of one feature |
| `logically-related` | Related in purpose, with no direct code link |

- `from` and `to` are existing node IDs. Don't restate a code edge.
- `explanation` says why, in one or two sentences. `citedLines` holds the lines that support it, and may be empty when no single line shows it.

## Citing lines

A cited line is `{ "path": "src/price.ts", "side": "new", "line": 1 }`.
- `side` is `new` for added and unchanged lines, and `old` for removed lines.
- Take numbers from the hunk header (in `@@ -a,b +c,d @@`, old lines start at `a` and new lines at `c`) or from `show`.
- The line must exist on that side of the snapshot. It may be in an unchanged file you read with `show --file`.
- Files whose content was omitted (binary, too large, not UTF-8) can't be cited.

## plan.json

Every field is required and no other fields are allowed.

```json
{
  "schemaVersion": 1,
  "snapshotId": "<the Snapshot line from planner-input.md>",
  "origin": "agent",
  "fallbackReason": null,
  "summary": "formatPrice now takes a currency. Its callers pass 'USD'.",
  "groups": [
    {
      "id": "contract",
      "title": "formatPrice gains a currency parameter",
      "description": "The definition changes its signature and output. Read it first.",
      "nodeIds": ["n_…"],
      "referenceNodeIds": [],
      "childGroupIds": []
    },
    {
      "id": "callers",
      "title": "Callers pass a currency",
      "description": "Each caller now passes 'USD'. Check that none should pass another currency.",
      "nodeIds": ["n_…", "n_…"],
      "referenceNodeIds": [],
      "childGroupIds": []
    }
  ],
  "groupOrder": ["contract", "callers"],
  "edgeVerdicts": [
    {
      "edgeId": "e_…",
      "verdict": "yes",
      "via": "direct",
      "reason": "checkout.ts imports formatPrice from ./price.ts and calls it.",
      "citedLine": { "path": "src/checkout.ts", "side": "new", "line": 4 }
    }
  ],
  "inferredRelationships": []
}
```

- Group and inferred relationship IDs are yours: lowercase letters, digits, `-` and `_`, starting with a letter or digit, at most 64 characters, and unique.
- `title`, `reason` and `explanation` can't be empty.
- The JSON Schema is `schemas/review-plan.schema.json` in the better-code-review package.

## Repairing validation errors

`validate` reports every error at once, except schema errors, which come alone because the other checks need a well-formed plan. Fix them all before running it again. `path` points at the value to change, and `message` says how.

| `code` | Usual fix |
|---|---|
| `json` | The file isn't valid JSON. Rewrite it whole, with no comments, trailing commas or code fence |
| `schema` | A field is missing, misspelled, extra or the wrong type. Match the shape above exactly |
| `snapshot` | Copy `snapshotId` from the `Snapshot:` line again. If you regenerated, plan against the new input |
| `origin` | Set `origin` to `"agent"` and `fallbackReason` to `null` |
| `duplicate-id` | Rename one of the two groups or relationships, and update `groupOrder` and `childGroupIds` |
| `reserved-id` | Rename the child group; `ungrouped` is reserved |
| `unknown-id` | Use an ID from `planner-input.md`. For a group ID, define the group or remove the reference |
| `multiple-homes` | Keep the node in one group's `nodeIds`. Move other mentions to `referenceNodeIds`, and remove duplicates |
| `nesting` | Keep nesting one level deep, with one parent per child and no group inside itself |
| `group-order` | List every top-level group once, and no child groups |
| `verdict` | Drop verdicts on `verified` edges and second verdicts on one edge. Set `via` to `null` unless the verdict is `yes` |
| `citation` | Cite a line that exists on that side. Check the hunk header, or `show` the file |

If the same error comes back after a fix, read its `message` again. After three rounds, stop as [SKILL.md](../SKILL.md#4-validate-and-repair) says.
