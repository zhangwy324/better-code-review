# Data contracts

The versioned contracts every stage reads and writes (issue #8; design reference §7, §9.1–9.8; [MVP spec](../../docs/mvp-spec.md) D1–D12). The Zod schemas here are the source of truth. TypeScript types are inferred from them, and JSON Schema files are generated from them for other consumers.

| Contract | Module | Written to | Produced by | Read by |
|---|---|---|---|---|
| `ReviewRequest`, `ReviewTarget` | `request.ts` | in memory | CLI / skill (#20, #25) | Git extractor |
| `ChangeSet`, `FileChange`, `DiffHunk` | `changeset.ts` | `changes.json` | Git extractor (#10–#13) | analyzers, graph builder, renderer |
| `StructuralChangeSet` | `structural.ts` | in memory | Structural analyzer (#15) | semantic analyzer, graph builder |
| `SemanticEvidence` | `semantic.ts` | in memory | Semantic analyzer (#16, #17) | graph builder |
| `ChangeGraph` | `graph.ts` | `graph.json` | Graph builder (#18) | planner, renderer |
| `ReviewPlan`, `InferredRelationship` | `plan.ts` | `plan.json` | agent (#25) or fallback (#24) | validator (#23), renderer |
| `ReviewFeedback`, `ReviewComment` | `feedback.ts` | `review-feedback.json` | viewer (#33) | agent |
| `SourceRange`, `CodeLocation`, IDs | `common.ts` | — | — | all |

Each module's header lists the invariants that apply to it. This file covers what is shared.

## Conventions

- **Strict objects.** Unknown fields are rejected, both by Zod and by the JSON Schemas (`additionalProperties: false`). That is how the plan validator refuses extra content from the model, such as code text (D6, #23).
- **Absent is `null`, not missing.** Every field is required. One that may have no value is nullable. Producers write `null` explicitly, so every document of a version has the same shape.
- **Sides are `old` and `new`**, as in Git: `old` is the base, `new` the head (or the working tree). Fields are named `oldPath`, `newRange` and so on.
- **Paths** are repository-relative and `/`-separated, exactly as Git reports them.
- **`SourceRange`:** lines are 1-based and `endLine` is inclusive. Columns are optional, 1-based, counted in UTF-16 code units (as JavaScript strings and LSP's default), and `endColumn` is exclusive. Hunks keep Git's own `start,lines` header numbers instead, because a zero-line side (`+4,0`) has no inclusive range.
- **Key order is the schema's order.** Parsing returns keys in the order the schema declares them, so serialising a parsed document is deterministic.

## IDs

IDs are unique within a snapshot and identical across runs on the same snapshot (spec invariant 1, M1 acceptance). They are not stable across snapshots, and nothing in v0.1 needs them to be (D4: comments are not carried across snapshots).

**Generated IDs** are a kind prefix plus 16 hex characters of a SHA-256 over JSON-encoded parts: `stableId(prefix, parts)` in `ids.ts`. The prefix makes a misplaced ID fail validation (a hunk ID where a node ID belongs). 64 bits leaves collisions vanishingly unlikely at review sizes; the invariant validator (#19) still rejects duplicates.

| Prefix | Record | Parts (owner may refine, but must keep them deterministic) |
|---|---|---|
| — | `snapshotId` | Full SHA-256 hex. Commit/range/PR: `["git-revisions/2", baseRevision, headRevision, renameLimit]` (`src/git/extract.ts`; the format tag changes when the pinned diff options do, and the rename limit is configurable). A PR therefore shares its snapshot with the equivalent merge-base range, and its title and description are not hashed. Local: `["git-local/2", baseRevision, tree, renameLimit]`, where `tree` is the captured working tree (`src/git/local.ts`) |
| `h_` | `DiffHunk` | `oldPath`, `newPath`, `oldStart`, `oldLines`, `newStart`, `newLines` (#10) |
| `ent_` | `ChangedEntity` | `path`, `container`, `kind`, `name`. Overloads are one entity, so these are unique; in the rare clash between an added and a deleted entity, `change` is added (`src/analysis/structural/analyze.ts`, #15) |
| `n_` | `ChangeNode` | node `kind` plus the entity ID, or the file path for `file` nodes (#18) |
| `e_` | `CodeEdge` | `relation`, `from` (or `fromPath`), `to` (#18) |
| `ev_` | `EvidenceRecord` | `method`, `relation`, source and target entity IDs, and the location: path, side, start line and column (`src/analysis/semantic/analyze.ts`, #17) |

The snapshot ID is a document field, not part of the hashed parts: an ID only has meaning together with its snapshot.

**Local IDs** (groups, inferred relationships, comments) are chosen by the agent, the fallback planner or the viewer: lowercase letters, digits, `-` and `_`, up to 64 characters. They are safe in a URL fragment or DOM id. A `crypto.randomUUID()` fits. The group ID `ungrouped` is reserved for the Ungrouped / requires review group (D1).

## Versioning

Each persisted document carries an integer `schemaVersion`, and each contract is versioned on its own. `ReviewRequest` is in memory only and has none.

- **Readers accept exactly the version they were built for.** `parseContract(name, data)` checks `schemaVersion` before anything else and throws `SchemaVersionError`, which says whether the file came from a newer build. Unknown fields are rejected anyway, so "additive" changes are breaking for older readers and there are no minor versions.
- **Any change to a contract's shape or meaning bumps its version**, in the same PR, along with the regenerated JSON Schema files.
- **Migrations:** when a bumped contract may be read from a file written by an older release, the PR adds a migration from the previous version, applied in `parseContract`, and a test that a previous-version example migrates. Today that is only `ReviewFeedback`, since it outlives the run that produced it (D5). `changes.json`, `graph.json` and `plan.json` are written and read by the same run (D9: a rerun overwrites them), so for those an old version is an error and the fix is to regenerate.
- **Until v0.1 ships**, nothing has been released and all contracts stay at version 1 while they change. The first release freezes them, and the rules above apply from then on.

## What is checked where

The schemas check each document on its own: shape, types, ID formats, enums, paths and range order. Rules that need more than one document, or a whole document, belong to the validators:

| Rule | Where |
|---|---|
| Unique hunk IDs; every hunk on a node or in `uncoveredHunkIds`; every referenced ID exists; `verified` edges cite confirmed LSP evidence | Graph invariant validator (#19) |
| Every node has one home group; IDs in the plan exist in the graph; verdicts only on existing `possible` edges; cited lines exist; no code text | Plan validator (#23) |
| Feedback anchors exist in the snapshot | Viewer (#33) and the agent workflow (#25) |

## JSON Schema

`npm run schemas` writes one draft 2020-12 file per persisted contract to [`schemas/`](../../schemas), which ships in the package. A test fails when they are out of date. They express everything above except the Zod refinements (repository-relative paths, `endLine >= startLine`, cap counts), which only the Zod schemas check.
