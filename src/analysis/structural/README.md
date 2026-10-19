# Structural analyzer

Parses changed files with `web-tree-sitter`, finds their declarations with our own query files (issue #14; [ADR 0001](../../../docs/adr/0001-analyzer-runtime.md); design reference §8.3, §10.3), and works out which entities each hunk changed (#15, §9.3). `analyzeStructure(changeSet, options)` turns a `ChangeSet` into a `StructuralChangeSet`.

| File | Contents |
|---|---|
| `analyze.ts` | `analyzeStructure()`: skips, hunk attribution, module entities, the output |
| `entities.ts` | `extractFacts()`: the entities of one file side, with extents, containers and fingerprints |
| `match.ts` | `matchEntities()`: before/after matching |
| `test-files.ts` | `classifyTestFile()`, `declaredTestRoots()` |
| `languages.ts` | Language detection by extension, grammar loading, query compilation |
| `parser.ts` | `StructuralParser` (parse one file, or both sides of a `FileChange`), `declarations()`, `freeTrees()` |
| `grammars/` | Vendored grammar `.wasm` files, their licences and `manifest.json`. Generated: don't edit by hand |
| `queries/` | Our declaration queries, one `.scm` per language |

## Languages

Built in: **TypeScript, TSX, JavaScript (with JSX), Python and Java**, as decided in ADR 0001 and the MVP spec. Go and every other language are not built in; they arrive later as on-demand language bundles (#45). Their files parse to `{ status: 'unsupported' }`, which callers report (a file node, `text-only` tier). It is never thrown.

| Grammar | Extensions | Queries |
|---|---|---|
| `typescript` | `.ts` `.mts` `.cts` (including `.d.ts`) | `javascript.scm` + `typescript.scm` |
| `tsx` | `.tsx` | `javascript.scm` + `typescript.scm` |
| `javascript` | `.js` `.mjs` `.cjs` `.jsx` | `javascript.scm` + `javascript-only.scm` |
| `python` | `.py` `.pyi` | `python.scm` |
| `java` | `.java` | `java.scm` |

Detection uses the extension only, case-insensitively. Each side of a change is detected from its own path, so `price.js` → `price.ts` parses the old side as JavaScript and the new side as TypeScript.

## Grammars: sourcing and shipping

The `.wasm` grammars are **vendored** in `grammars/`, copied from the official `tree-sitter-<lang>` npm packages, and shipped in the package (the build copies `grammars/` and `queries/` to `dist/`).

- **Why not depend on the grammar packages?** Each one is a native Node addon package: an `install` script (`node-gyp-build`), `node-addon-api`, and 6–39 MB of C sources and prebuilt binaries per package, ~60 MB in all. We only need one ~0.4–1.4 MB `.wasm` from each (~4.1 MB in total).
- **Pins** are the `package`, `version` and `file` fields in `grammars/manifest.json`. `npm run grammars` (`scripts/grammars.ts`) downloads each pinned tarball with `npm pack`, which verifies the registry's integrity hash, then copies the `.wasm` and `LICENSE` and records the tarball integrity, the `.wasm` sha256, the licence and the repository. A pin whose recorded integrity no longer matches the registry fails. Rerunning with unchanged pins changes nothing.
- **Checks:** a test compares every `.wasm` with its sha256 and checks that the manifest's engine version is the installed `web-tree-sitter`. `npm run licenses` checks each grammar's licence against the policy (ADR 0002) and adds its licence text to `THIRD_PARTY_NOTICES`.
- **Engine:** `web-tree-sitter` is pinned exactly, because grammar `.wasm` files are built for an ABI range. After upgrading it, run the tests; if a grammar no longer loads, bump its pin and rerun `npm run grammars`.
- To change or add a grammar: edit the manifest pin, run `npm run grammars`, check the licence, and commit the result.

## Query conventions

- `@definition.<kind>` captures the declaration node. Kinds: `function`, `method`, `constructor`, `class`, `interface`, `enum`, `namespace` (TS `namespace` and `module` blocks; a container like a class), `type`, `import`.
- `@name` captures its name. For imports it is the module specifier.
- `(#set! test "true")` marks a test: JS/TS `describe`/`it`/`test` blocks (kind `function`, named by their title), pytest `test*` functions and methods and `Test*` classes, and JUnit `@Test`-style methods. This is a per-declaration hint; deciding whether a *file* is a test file is #15's job (MVP spec D2).
- Captures starting with `_` are helpers and are ignored.
- When several patterns capture the same declaration and name, the **earliest pattern sets the kind** and any of them can mark it as a test. So specific patterns (constructors) go before general ones (methods).
- TypeScript and TSX run `javascript.scm` followed by `typescript.scm`, so `javascript.scm` may only use node types that exist in all three grammars. JavaScript-only node types (class `field_definition`) go in `javascript-only.scm`.
- Anonymous default exports (`export default function () {}`) are named `default`. Assignments (`obj.f = () => …`, `module.exports.f = function …`) are named by the last property.

Known query gaps (re-exports, CommonJS `require`) are tracked in #60. `Declaration.range` covers the node only; entity extents (below) add wrappers, comments and decorators.

## Changed entities (#15)

**Entities.** Every declaration except imports is an entity. Its extent grows to a statement that wraps it alone (`export`, `const`, Python `decorated_definition`), then back over the comments and decorators directly above it: no blank line in between, and not a trailing comment of the code before (#42: Javadoc and JSDoc belong to the method, not the class). Its container is the names of the enclosing entities joined with `.` (`Calc.tax`, `<describe title>.<it title>`).

**Overloads are one entity** (#42): declarations with the same path, container, kind and name, such as TS overload signatures, Java overloads, Python `@overload` and getter/setter pairs. The entity's range spans its first to last member; attribution uses each member's own extent.

**Attribution** (D2). Added lines are looked up on the new side and removed lines on the old side; context lines are ignored. A line belongs to the innermost entities containing it: a method rather than its class, and both of two one-liners sharing the line. A hunk is attached to every entity one of its lines belongs to. Lines outside every entity (imports, top-level statements) attach the hunk to the file's `module` entity, whose ranges are null. A changed line inside a class but outside its methods (a field) belongs to the class.

**Matching** runs outermost entities first, so "same container" means the two parents were matched to each other. The phases follow sem (a design reference only):

1. Same file, kind, name and container.
2. Same content hash (the code without its name, comments or whitespace): same scope first, then any file. A rename or a move.
3. Same file, kind and container, same parameters and return type, and at least 50% token similarity.
4. Same file, kind and container, and at least 80% token similarity (Dice over code tokens), best pairs first.

Entities under 16 tokens only match by name, since empty bodies hash alike. A matched pair is `moved` when its file or its parent changed, `renamed` when its name changed, and `modified` otherwise; unmatched entities are `added` or `deleted`. Only entities with a hunk on either side are reported.

**Files without structure** have no entities. Their hunks go to `unattributedHunkIds`, and the graph gives them a file node (D2):

| `skipped` | When |
|---|---|
| `binary` | Git reported a binary diff |
| `too-large` | either side is over `MAX_PARSE_BYTES` (1 MiB), or #13 omitted the content |
| `generated` | `*.min.js`, `*.generated.*`, `*_pb2.py`; a `@generated`, `DO NOT EDIT` or `auto-generated` comment in the first five lines; or a line over 2,000 characters (minified) |
| `parse-error` | a changed line is inside an ERROR or MISSING node, where tree-sitter's recovery could put it in the wrong entity |

A file without a built-in grammar on either side, a symlink or a submodule is `text-only` with `skipped: null`. Syntax errors away from the changed lines are tolerated.

**Tiers.** Built-in languages are `supported` and everything else `text-only`. `community` (upstream `tags.scm`) is not produced in v0.1, which ships built-in languages only.

**Test files** (D2) are classified in order:

1. Path conventions give `path-convention`: `*.test.*`, `*.spec.*`, `test_*.py`, `*_test.py`, `conftest.py`, `*Test.java`, `*Tests.java`, `*IT.java`, or a `test`, `tests`, `spec`, `__tests__` or `__mocks__` directory.
2. Test roots from `declaredTestRoots()` give `declared-test-root`.
3. Content gives `content`, only to break a tie: the path contains a test-related word (`testing/`, `fixtures.py`, `testUtils.ts`…) and the file imports a test framework or declares a test.

`declaredTestRoots(read)` reads pytest `testpaths` (`pyproject.toml`, `pytest.ini`, `tox.ini`, `setup.cfg`), jest `testMatch` and `testRegex` (`package.json`, `jest.config.*`), vitest `test.include` (`vitest.config.*`, `vite.config.*`), the Maven `testSourceDirectory` and Gradle test source sets, at the repository root. Config is part of the change under review, so it is read as text and never evaluated; only literal arrays and strings are understood.

## Memory

Trees live in WASM memory and are not garbage-collected. Free them with `freeTrees()` (or `tree.delete()`) as soon as a file is done; `Declaration.node` is invalid afterwards. WASM memory grows but never shrinks, so `analyzeStructure()` does not parse files over `MAX_PARSE_BYTES`, and frees each file's trees as soon as its entities are extracted.
