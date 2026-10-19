# Structural analyzer

Parses changed files with `web-tree-sitter` and finds their declarations with our own query files (issue #14; [ADR 0001](../../../docs/adr/0001-analyzer-runtime.md); design reference §8.3, §10.3). Changed-entity extraction, hunk attribution and before/after matching build on it in #15.

| File | Contents |
|---|---|
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
| `javascript` | `.js` `.mjs` `.cjs` `.jsx` | `javascript.scm` |
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

- `@definition.<kind>` captures the declaration node. Kinds: `function`, `method`, `constructor`, `class`, `interface`, `enum`, `type`, `import`.
- `@name` captures its name. For imports it is the module specifier.
- `(#set! test "true")` marks a test: JS/TS `describe`/`it`/`test` blocks (kind `function`, named by their title), pytest `test*` functions and methods and `Test*` classes, and JUnit `@Test`-style methods. This is a per-declaration hint; deciding whether a *file* is a test file is #15's job (MVP spec D2).
- Captures starting with `_` are helpers and are ignored.
- When several patterns capture the same declaration and name, the **earliest pattern sets the kind** and any of them can mark it as a test. So specific patterns (constructors) go before general ones (methods).
- TypeScript and TSX run `javascript.scm` followed by `typescript.scm`, so `javascript.scm` may only use node types that exist in all three grammars.

The queries are a starting point. Known gaps for #15: anonymous default exports, assignments such as `module.exports.f = …` and `obj.f = () => …`, re-exports (`export { a as b } from …`), CommonJS `require`, Python lambdas, TS namespaces and object-literal methods. Declaration ranges cover the node only: leading comments, and decorators where the grammar makes them siblings (Python `decorated_definition`, TS class members), are not included. Java annotations are inside the declaration.

## Memory

Trees live in WASM memory and are not garbage-collected. Free them with `freeTrees()` (or `tree.delete()`) as soon as a file is done; `Declaration.node` is invalid afterwards. WASM memory grows but never shrinks, so very large files must be capped before parsing (#13, #15).
