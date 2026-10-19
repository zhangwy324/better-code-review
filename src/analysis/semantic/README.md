# Semantic analysis: LSP tier

The optional precision tier of the semantic analyzer (issue #16). It finds language servers that are already installed, asks them for references to changed entities, and reports per language what it could and could not do. It is our own minimal JSON-RPC-over-stdio client with no dependencies ([ADR 0001](../../../docs/adr/0001-analyzer-runtime.md)).

**LSP is optional.** A missing, broken, slow or unhealthy server never fails a review. It becomes a capability gap in `SemanticEvidence.languages` (`LanguageCapability`), and an answer from it is `unknown`, never "no references".

| File | Contents |
|---|---|
| `jsonrpc.ts` | `Content-Length` framing, requests with timeouts, server-to-client requests |
| `client.ts` | One server process: `initialize`, capability checks, document sync, `$/progress`, `language/status`, diagnostics, URIs |
| `servers.ts` | Known servers, discovery, the exact command lines |
| `normalise.ts` | Text-level rules that make servers agree: import lines, alias names, constructor calls, method declarations, receivers |
| `session.ts` | `LspSession`: start-up, readiness, crash recovery, references, health check, capability report |

## API

```ts
const lsp = await LspSession.start(snapshotRoot, ['typescript', 'python'], options);
const result = await lsp.references({
  language: 'typescript', path: 'src/price.ts', line: 1, column: 17, kind: 'function',
});
// result.status === 'ok': result.references (confirmed sites), result.unresolved, result.complete
// result.status === 'unknown': result.reason — leave the candidate `possible`
const health = await lsp.projectHealth('typescript', ['src/price.ts', 'src/checkout.ts']);
const languages = lsp.capabilities(); // LanguageCapability[] for SemanticEvidence.languages
await lsp.close();
```

How #17 is expected to use it, per candidate edge between changed entities (D12):
- A candidate inside a returned reference's range is **confirmed**. Match by range with `rangeContains`, not by start column (jdtls starts `new Gson()` at `new`).
- A candidate not returned is **rejected** only when the answer is `ok` and `complete`, it is not in `unresolved`, and `projectHealth` for the files involved is `healthy`. Otherwise it stays `possible`.
- Lines are 1-based and columns 1-based UTF-16, as in `SourceRange`. `line`/`column` is the entity's name.

### Targets

| `kind` | Query |
|---|---|
| `function`, `method`, `class`, … | `textDocument/references` at the name. Functions and methods are cross-checked with `callHierarchy/incomingCalls` |
| `constructor` | Pass the **class name's** position. Python `__init__` has no references of its own (#42). Only call sites are kept (`new C(`, `C(`); type annotations, `isinstance(x, C)` and imports are not |
| `method` overriding a base method | Also pass `baseMethods` (positions of the overridden methods) and `receiverTypes` (the class, its subclasses and its ancestors). `references` on an override misses calls through the base type (#42) |

**Override filter.** tsserver answers for the whole override family, and the base-method query does by design. Without a filter, 19 of 28 dispatch-only results in #42 were wrong. So for methods, every reference goes through the same rules:
- Other declarations of the method are dropped.
- The receiver's static type comes from `textDocument/typeDefinition` on the receiver token. With `receiverTypes`, a reference whose type is not in the list is dropped (sibling classes).
- `super.m()` through a base method is static dispatch to the base and is dropped. `super.m()` among the direct answers is left `unresolved`.
- Anything undecidable from a base-method query goes to `unresolved` (`f().m()`, `a[0].m()`, implicit `this`). Direct answers are trusted.

## Readiness

Servers can return an empty list without an error while they are still loading the project (#4). The session never reports "no references" before the server is ready:
1. **jdtls:** wait for `language/status` `ServiceReady` (6–20 s in #42).
2. **Others:** wait while any `$/progress` work is in flight (bounded).
3. Ask `references` until **two consecutive answers are identical** (#42). `ContentModified` errors are retried.
4. An empty answer is believed only `emptyGraceMs` after the server started.
5. For functions and methods, `callHierarchy/incomingCalls` must not know call sites that `references` lacks. It was correct immediately in #4.
6. If none of this settles within `readyMs`, the answer is `unknown` and the language reports `not-ready`.

## Normalisation

Different servers give different answers to the same question. After these rules, typescript-language-server (tsserver), TS 7 `tsc --lsp` and pyright return identical sites on the fixture:
- **Import lines are dropped** for every server. TS 7 omits them, while tsserver and pyright include them. They map to module level, which text search covers (ADR 0001).
- **Alias names are dropped** (`fmt` in `export { formatPrice as fmt }`). Only tsserver returns them. The re-export line itself and the use of the alias (`fmt(1)`) are kept.
- **Method declarations are dropped**. tsserver lists sibling and base overrides.
- Sites outside the workspace root are dropped. Paths are repository-relative with `/`. `file:` URIs are compared after normalisation (Windows drive letters, `%3A`).

## Project health

pyright returned 4 of 37 references on click with no error, because `src/` was not on its path (#42). `projectHealth(language, paths)` measures the share of unresolved imports in the files involved:
- **Diagnostics:** pulled with `textDocument/diagnostic` when the server offers it, otherwise the pushed `publishDiagnostics`.
- **Unresolved-import diagnostics** are recognised by code: pyright `reportMissingImports`, TS 2307 and 2792, jdtls 268435846. Stubs-only imports (`reportMissingModuleSource`) count as resolved.
- **Imports** are counted per statement, approximately, by text.
- The project is **healthy** when the share is at most `maxUnresolvedImportShare` (default 0).
- When it isn't, the language reports `unhealthy` with the first unresolved import and what to do. A server that publishes no diagnostics counts as not healthy.

## Configuration

`LspOptions`, all optional:

| Option | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` starts nothing; every language reports `disabled` |
| `allowProjectCode` | `false` | Allow servers that run project code while indexing (jdtls, rust-analyzer), and a virtualenv interpreter inside the repository (D11) |
| `servers` | — | `{ typescript?, python?, java?, rust? }`: `{ command, args?, initializationOptions?, settings? }` replaces discovery for that server. The project-code opt-in still applies to Java and Rust |
| `timeouts` | see `DEFAULT_TIMEOUTS` | `initializeMs` 60 s, `requestMs` 30 s, `readyMs` 60 s, `emptyGraceMs` 10 s, `retryDelayMs` 1 s, `healthMs` 30 s |
| `maxRestarts` | `1` | Restarts after a crash; the failed request is retried once per restart. After that the language reports `failed` |
| `maxUnresolvedImportShare` | `0` | Health threshold |
| `searchPath` | `PATH` | Where to look for servers |

The CLI options that set these are not defined yet (#20).

## Discovery and the exact commands run

Discovery **reads files only**: `package.json` files and the search path. It never runs anything to probe a version, and never installs or downloads a server (D11). `node` below is the Node.js running better-code-review (`process.execPath`). Node-based servers are run as `node <script>`, so npm's `.cmd` shims are not needed on Windows. Every server runs with the snapshot root as its working directory, and its workspace is that root.

| Language (grammar) | Tried in order | Command |
|---|---|---|
| TypeScript, TSX, JavaScript | 1. Project `node_modules/typescript` ≥ 7 | `node <root>/node_modules/typescript/bin/tsc --lsp --stdio` |
| | 2. `typescript-language-server` (project `node_modules`, then `PATH`) with a TypeScript < 7: the project's, else the one it resolves next to itself | `node <pkg>/lib/cli.mjs --stdio`, with `initializationOptions.tsserver.path` = that TypeScript's `lib` |
| | 3. `tsc` on `PATH` from TypeScript ≥ 7 | `node <pkg>/bin/tsc --lsp --stdio` |
| Python | 1. `pyright` package (project `node_modules`, then `PATH`) | `node <pkg>/langserver.index.js --stdio` |
| | 2. `basedpyright` package, the same way | `node <pkg>/<bin> --stdio` |
| | 3. `pyright-langserver` / `basedpyright-langserver` executable on `PATH` (e.g. the PyPI wrapper) | `<path> --stdio` |
| Java (**opt-in**) | `jdtls` on `PATH` | `jdtls -data <tmpdir>/better-code-review/jdtls/<hash of root>` |
| Rust (**opt-in**) | `rust-analyzer` on `PATH` | `rust-analyzer` |

On Windows, a `.cmd`/`.bat` found on `PATH` that isn't an npm shim with its package next to it is run through the shell, with the command and arguments quoted.

What is reported (`LanguageCapability.server`): the server name, its version (`serverInfo` from `initialize`, else its `package.json`), and `configuration`, e.g. `TypeScript 5.9.3 from the project, via typescript-language-server` or `extraPaths: src (src layout)`.

**Settings we send.**
- **pyright:** `python.analysis.extraPaths = ["src"]` when the root has a `src/` layout (`src/<pkg>/__init__.py` and no `src/__init__.py`).
- **pyright, with the opt-in only:** `python.pythonPath` = `<root>/.venv` or `<root>/venv` interpreter.

A `pyrightconfig.json` or `[tool.pyright]` in the project takes precedence over these, and the configuration says so. Nothing is ever written to the repository.

## Security

Language servers are programs run on the user's machine against code under review (design reference §14.2).
- **Opt-in servers.** jdtls imports Maven and Gradle builds, which runs build scripts and plugins. rust-analyzer runs `build.rs` and procedural macros. Both need `allowProjectCode`. Without it, the language reports `needs-opt-in` and the server is not started.
- **pyright** runs a Python interpreter to find import paths. By default that is `python` on `PATH`, the user's own. A repository virtualenv interpreter is project-controlled, so we only point pyright at it with the opt-in. **Known gap:** a `pyrightconfig.json` in the repository can still name an interpreter or venv itself.
- **The project's own `node_modules`** (TypeScript, typescript-language-server, pyright) is preferred, as ADR 0001 decided. Those packages come from the user's own install. **Known gap:** if `node_modules` is committed, a reviewed change could alter them.
- Servers get the snapshot root as their workspace and nothing else. The client sends no file contents except the files it opens from that root.

## Setup notes

- **TypeScript:** `typescript@latest` is 7.x (Go-native) and has no `tsserver.js`. typescript-language-server then fails unless a TypeScript 5.x/6.x is installed next to it or in the project. TS 7's `tsc --lsp` needs nothing else.
- **Python:** install pyright (`npm i -g pyright`, or in the project). Projects need their dependencies where pyright finds them (the active `python`, or the project's settings). `src/` layouts are handled automatically. The PyPI `pyright` wrapper downloads the npm package on first use; that download is outside our control.
- **Java:** jdtls 1.62 needs a Java 25 runtime (#42). Not tested here: there's no JDK on the development machine.
- **Rust:** `rustup component add rust-analyzer`. Not tested.

## Tests

- `*.test.ts` runs everything against an in-process fake server: protocol, readiness, normalisation, overrides, crashes, health.
- `servers.integration.test.ts` runs the real servers on the #3/#4 signature fixture. Each suite is **skipped when its server isn't installed**, so CI passes without servers. To run them, put servers on `PATH`, or list directories in `BCR_LSP_TEST_PATH` (each is tried on its own, so tsserver and TS 7 can both run). For example:

```bash
BCR_LSP_TEST_PATH=/a/node_modules/.bin:/b/node_modules/.bin npx vitest run servers.integration
```
