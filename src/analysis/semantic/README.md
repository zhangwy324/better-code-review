# Semantic analyzer

Answers "how are the changed entities related to each other?" (design reference §8.4, §9.4). `analyzeSemantics(changeSet, structure, options)` in `analyze.ts` turns a `ChangeSet` and its `StructuralChangeSet` into `SemanticEvidence` (issue #17). Candidates come from deterministic search, which owns recall. An installed language server (the LSP tier, issue #16) can then confirm or reject them, but is never required.

| File | Contents |
|---|---|
| `analyze.ts` | `analyzeSemantics()`: the candidate pipeline, LSP verification, test-file edges, caps, the output |
| `hits.ts` | `findHits()`: text search and the tree-sitter filter for one file |
| `imports.ts` | Import-path resolution: bindings, exports and re-exports, module paths, Java imports |
| `snapshot-files.ts` | `SnapshotFiles`: read and search the whole snapshot (`gitSnapshotFiles`, `changeSetFiles`) |
| `jsonrpc.ts` | `Content-Length` framing, requests with timeouts, server-to-client requests |
| `client.ts` | One server process: `initialize`, capability checks, document sync, `$/progress`, `language/status`, diagnostics, URIs |
| `servers.ts` | Known servers, discovery, the exact command lines |
| `normalise.ts` | Text-level rules that make servers agree: import lines, alias names, constructor calls, method declarations, receivers |
| `session.ts` | `LspSession`: start-up, readiness, crash recovery, references, health check, capability report |

## Caller candidates (#17)

```ts
const files = gitSnapshotFiles(repo, changeSet);
const lsp = await LspSession.start(headWorkingTree, languages, lspOptions); // optional
let old: LspSession | undefined;
const oldLsp = async (needed: string[]) => {
  await checkoutRevision(repo, changeSet.baseRevision, baseWorkingTree); // src/git/checkout.ts
  return (old = await LspSession.start(baseWorkingTree, needed, lspOptions));
}; // optional, needs `lsp`
const evidence = await analyzeSemantics(changeSet, structure, { files, lsp, oldLsp });
await lsp.close();
await old?.close();
```

- `files` gives access to unchanged files, for imports, re-exports and definition counts. Without it only the changed files are read, nothing counts as unambiguous, and imports into unchanged files stay unresolved.
- `lsp` is any `LspSession` (or a `ReferenceProvider`) started on a working tree holding the **new** side. The caller starts and closes it. Without one, every language reports `disabled` and nothing is verified.
- `oldLsp` starts a session on a working tree holding the **old** side, for the languages it is given. The analyzer calls it at most once, and only when old-side candidates need it (step 6 below); the caller closes what it returned.

**Scope (MVP spec D12).** Only hits inside other changed entities count: entities a hunk touches on either side. Unchanged callers are never searched for. Both sides are searched: old-side names in old-side content, so a removed call is found too. Files without structure (text-only, binary, too large, generated, unparseable) have no entities and are not searched. Hits only relate files of the same language family: TS/TSX/JS, Python, Java.

**Targets.** Every changed entity with a name, except JS/TS test blocks, which are named by their title (`titled`, structural README); they are not counted as definitions either. Overloads are one entity (#15), so their candidates are shared. Constructors are searched by their class name, and only call sites count (#42): `new C(…)`, `C(…)`, not type annotations, `isinstance(x, C)` or imports. Constructor chaining is searched too: `super(…)` in direct subclasses (TS, Java), `this(…)` in the same class (Java), and `super().__init__(…)` in direct subclasses (Python). These were the only text-search misses in #42.

### The pipeline

In the order #42 settled (`docs/research/candidate-adjudication.md`):

1. **Text search** for each target's name on its side, whole words only. **Aliases:** every import in a changed file is resolved, and one that reaches a target under another name (`import { fmt } from './reexport'` where `reexport.ts` has `export { formatPrice as fmt }`, `from tax import tax as levy`) adds that name to the search in that file.
2. **The tree-sitter filter** (`hits.ts`). The node under each occurrence decides:
   - comments and strings are skipped;
   - declarations of the name are skipped: functions, classes, methods, variables, parameters, fields;
   - object keys and keyword arguments are skipped;
   - import and re-export lines (`export { a as b }`, `export default a`) are skipped. They are module-level, not callers, and import resolution uses them instead;
   - what remains is a code hit: a call or a reference, with its receiver (`t.tax` → `t`), and whether it is in a base-class list or chains a constructor.

   Each hit is mapped to the innermost entity containing it. It is kept only when that entity is changed, or when it is outside every entity and the file's `module` entity is changed. A hit inside the target itself (recursion) is dropped.
3. **The unambiguous rule.** A plain call (no receiver, not an alias) of a name with exactly one definition on that side, across the whole snapshot, is accepted as `possible` with no further work (100% correct in #42). Definitions are counted by `git grep -w` plus parsing the files it finds, up to 200 files; beyond that, or without `files`, the name counts as ambiguous.
4. **Import-path resolution** (`imports.ts`), for every other hit except constructor chaining:
   - **Bare names** (`formatPrice(…)`): a definition in the file, else its import binding, followed through re-exports up to 3 levels (`MAX_REEXPORT_DEPTH`), else `export *` / `from m import *`. Reaching the target is `confirmed`; reaching another definition, or a module, is `rejected`.
   - **A bare name neither imported nor defined in the file cannot be the target** (TS/JS and Python, #42): `rejected`. Not in a JS script with no imports or exports (its names are global), nor in a file that uses `require(…)` or `import(…)`.
   - **Module attributes** (`t.tax(…)`, `ns.formatPrice(…)`): the receiver's binding names the module, which is then resolved like a bare name. `Fmt.formatPrice` where `Fmt` resolves to the target's class is `confirmed`.
   - **Java:** a class name is the file's own type, a single-type import, or else the file's package. A static import names a method. Only a type the file declares or an explicit import says `rejected`; a same-package guess only confirms.
   - Module paths: relative TS/JS specifiers with the usual extensions and `index` files (`./x.js` also finds `./x.ts`); Python modules under the repository root or `src/`, relative imports, and `from pkg import mod` as a submodule when `pkg` defines no `mod`.
   - Anything else is unknown and adds no record: package imports, `tsconfig` path aliases, top-level variables, receiver calls (`obj.m()`, which only types settle), scopes and shadowing.
5. **LSP**, when a session is given, for new-side candidates that import resolution did not reject. One `references` query per target, at its name (a constructor's class name), with the readiness and normalisation rules below.
   - A method of a class with bases is asked with `receiverTypes`: its class and its direct bases (#21). Both TypeScript servers return the calls on a sibling implementation's receiver among an implementing method's references, so without the list `stripe.refund()` was verified as calling `PaypalGateway.refund`. A call the list rules out comes back in `excluded`, with the receiver's type and whether that type is a sibling (#80).
   - It is also asked with `baseMethods` (#81): the method of the same name in each direct base, found in the parsed snapshot. The base name is resolved like a bare name (the file's own definitions, then its imports, step 4) and must be a top-level class or interface that declares the method itself (for a TypeScript interface, a member signature). Bases from packages, `a.B`, nested classes, and a method a base only inherits are not found. pyright returns nothing for an override's own references (#42), so this is how `s.area()` with `s: Shape` verifies `Square.area`; both TypeScript servers already return such a call directly (`override-dispatch` fixtures).
   - **Known gap:** subclasses and further ancestors are not in `receiverTypes`, and only direct bases' methods are asked. A call on a subclass that inherits the method is still kept, since `definition` at the call lands on it (#80). Any other call on a subclass, or through a grandparent type, is excluded or left `unresolved`: it is no sibling, so it stays `possible`, never wrongly verified.
   - A candidate inside a returned site (`rangeContains`) gets an `lsp` `confirmed` record.
   - A candidate that is missing gets an `lsp` `rejected` record only when the answer is `ok` and `complete`, the site is not in `unresolved`, `projectHealth` is healthy for both the target's file and the candidate's file (checked once per file, so one file with unresolved imports only stops the rejections that involve it), the hit is not constructor chaining (which `references` does not return), and the target is not a method of a class with bases (calls through an overridden base method are not in its own references, #42).
   - A candidate in `excluded` whose receiver type is a **sibling** gets an `lsp` `rejected` record naming that type, under the same conditions (`ok`, `complete`, both files healthy, not chaining), even for a method of a class with bases: the server returned the call, and the type checker ruled it out (#80). `refundStripe(stripe: StripeGateway)` calling `stripe.refund()` is rejected as a call of `PaypalGateway.refund`. A non-sibling in `excluded` stays `possible`.
   - Otherwise nothing is recorded and the candidate stays `possible`. An `unknown` answer is never a rejection.
6. **The old side** (#66), when a new-side session is given. A removed call is a useful review signal (both ends are changed, D12), and an old-side candidate left undecided keeps its edge `possible` even when the new-side server rejected the same call.
   - **Base-side server.** Old-side candidates go to a session on the old side (`oldLsp`), with the same rules as step 5, only when their edge has no new-side hit left: the new side has none (a removed call), or every new-side hit was rejected. An edge a new-side hit already carries never starts it, and only the languages that need it are started. A confirmation verifies the edge even when its new-side hit was rejected.
   - **Carried-over rejections.** A new-side `lsp` rejection is carried over to the matching old-side hit when no server decided that hit and import resolution did not either: the same source, target, relation, name and receiver text (`f.formatPrice(1)` → `f.formatPrice(2)`), and the same position among the hits sharing those, when both sides have equally many. It is an `lsp` `rejected` record whose detail names the new-side hit. It never verifies anything (invariant 4), but if the receiver's type changed between the sides (`f: Fmt` → `f: Price`) it can drop a real removed call.
   - **Known limitation.** The base tree has no installed dependencies (`node_modules`, virtualenvs), so the health check usually stops the base-side server from rejecting; its confirmations still count, which covers removed calls. The carried-over rejections cover the rest.
7. **Test files** (MVP spec D2) keep one edge per (test file, changed entity), with one hit per side: the most decided (LSP-confirmed, then import-confirmed, then undecided), so the edge still says whether the call was added, removed or kept. Its detail says how many hits it stands for.
8. **Caps** (D1): at most `maxCandidatesPerEntity` (default 100) source entities per (target, relation), a test file counting as one. The rest are dropped from the records and reported in `caps` as "Showing N of M".

AI adjudication of what is still undecided (#43) is not here; it labels these candidates and never adds one. The planner selects them and writes their context ([`src/planner/README.md`](../../planner/README.md#caller-candidates-43)).

### Output

One `text-search` record with outcome `candidate` per kept hit, plus an `import-resolution` and an `lsp` record when those steps decided. Every record has the hit's exact location and side.

| Field | Value |
|---|---|
| `relation` | `calls` for a call of a function, method or constructor; `implements` for a class or interface in a base-class list; `references` otherwise |
| `sourceEntityId` | The changed entity containing the hit (for a test file, the one containing the kept hit) |
| `targetEntityId` | The changed entity named |
| `detail` | For text search, the hit's shape and the rules applied, e.g. `call; through the alias fmt` or `call; unambiguous: one definition, plain call`. For the deciding methods, why |
| `id` | `stableId('ev', [method, relation, source, target, path, side, line, column])` |

How the graph (#18) reads them, as the schema says: an edge is `verified` when a record is `lsp` `confirmed`; it is rejected when a record is `import-resolution` or `lsp` `rejected`; otherwise it is `possible`. Its `sides` are those of the hits it keeps, so a removed call is `old`. Rejected candidates stay in the records (D6).

`languages` is `LspSession.capabilities()` when a session is given: per language, the server, what was attempted, what failed, and the guidance (D11), with `side: 'new'`. A base-side session adds its own entries with `side: 'old'`. Without a session, every language of the change reports `disabled`.

## LSP tier (#16)

The optional precision tier finds language servers that are already installed, asks them for references to changed entities, and reports per language what it could and could not do. It is our own minimal JSON-RPC-over-stdio client with no dependencies ([ADR 0001](../../../docs/adr/0001-analyzer-runtime.md)).

**LSP is optional.** A missing, broken, slow or unhealthy server never fails a review. It becomes a capability gap in `SemanticEvidence.languages` (`LanguageCapability`), and an answer from it is `unknown`, never "no references".

## LSP API

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

How `analyzeSemantics()` uses it, per candidate edge between changed entities (D12; see "The pipeline" above):
- A candidate inside a returned reference's range is **confirmed**. Match by range with `rangeContains`, not by start column (jdtls starts `new Gson()` at `new`).
- A candidate not returned is **rejected** only when the answer is `ok` and `complete`, it is not in `unresolved`, and `projectHealth` for the files involved is `healthy`. Otherwise it stays `possible`.
- Lines are 1-based and columns 1-based UTF-16, as in `SourceRange`. `line`/`column` is the entity's name.

### Targets

| `kind` | Query |
|---|---|
| `function`, `method`, `class`, … | `textDocument/references` at the name. Functions and methods are cross-checked with `callHierarchy/incomingCalls` |
| `constructor` | Pass the **class name's** position. Python `__init__` has no references of its own (#42). Only call sites are kept (`new C(`, `C(`); type annotations, `isinstance(x, C)` and imports are not |
| `method` overriding a base method | Also pass `baseMethods` (positions of the overridden methods), `receiverTypes` (the types whose receivers can reach it) and `ownerClass` (the class name's position). `references` on an override misses calls through the base type (#42). The analyzer passes the direct bases' methods, and the class with its direct bases (step 5) |

**Override filter.** tsserver answers for the whole override family, and the base-method query does by design. Without a filter, 19 of 28 dispatch-only results in #42 were wrong. So for methods, every reference goes through the same rules:
- Other declarations of the method are dropped, including one-line bodies (`m(): void {}`) and interface signatures (`m(): void;`).
- The receiver's static type comes from `textDocument/typeDefinition` on the receiver token. With `receiverTypes`, a reference whose type is in the list is kept. So is one where `textDocument/definition` at the call lands only on the method itself: its type is a subclass that does not override it. Any other goes to `excluded` with that type (`A | B` for a union).
- **Siblings** (#80). An excluded type is a sibling when it is a class that extends or implements, directly or not, one of the method's class's direct bases, and is neither that class, a subclass of it, nor one of its ancestors. The analyzer passes the class's name position as `ownerClass`; the session reads each type's header (`extends`/`implements`, Python's parentheses; `typeHeaderAt` in `normalise.ts`), and follows every base with `textDocument/definition`, so types are compared by declaration, not by name. Declarations outside the workspace end the walk. It is not a sibling, so the call stays `possible`, when anything is undecided: a base that is not a plain name (`extends mixin(A)`) or cannot be followed, a type that is an interface, type alias or Python `Protocol` (the class itself may satisfy it), a union, or more than 32 ancestors.
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
- When it isn't, the language reports `unhealthy` with the first unresolved import and what to do. It keeps reporting it after later checks of other files pass. A server that publishes no diagnostics counts as not healthy.
- Health is a property of the files passed in. `analyzeSemantics()` checks each file on its own, so a file with an unresolved import only stops the rejections that involve it.

## Configuration

`LspOptions`, all optional:

| Option | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` starts nothing; every language reports `disabled` |
| `allowProjectCode` | `false` | Allow project code (D11): servers that run it while indexing (jdtls, rust-analyzer), a virtualenv interpreter inside the repository, packages from an untrusted project `node_modules`, and relative or in-repository `PATH` entries (see "Security") |
| `servers` | — | `{ typescript?, python?, java?, rust? }`: `{ command, args?, initializationOptions?, settings? }` replaces discovery for that server. The project-code opt-in still applies to Java and Rust |
| `timeouts` | see `DEFAULT_TIMEOUTS` | `initializeMs` 60 s, `requestMs` 30 s, `readyMs` 60 s, `emptyGraceMs` 10 s, `retryDelayMs` 1 s, `healthMs` 30 s |
| `maxRestarts` | `1` | Restarts after a crash; the failed request is retried once per restart. After that the language reports `failed` |
| `maxUnresolvedImportShare` | `0` | Health threshold |
| `searchPath` | `PATH` | Where to look for servers. Relative and in-repository entries are dropped without the opt-in |

The CLI (`generate`, #20) starts no session with `--no-lsp` and sets `allowProjectCode` (`--allow-project-code`); the rest keep their defaults.

## Discovery and the exact commands run

Discovery **reads files**: `package.json` files and the search path. The only command it runs is `git ls-files -- node_modules` (see "Security"). It never runs a server to probe a version, and never installs or downloads one (D11). `node` below is the Node.js running better-code-review (`process.execPath`). Node-based servers are run as `node <script>`, so npm's `.cmd` shims are not needed on Windows. Every server runs with the snapshot root as its working directory, and its workspace is that root.

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
- **TypeScript, both servers: automatic type acquisition off.** By default tsserver and TS 7 run `npm install @types/…` from the registry for the project's dependencies (D11). typescript-language-server gets `initializationOptions.disableAutomaticTypingAcquisition`; TS 7 gets `disableAutomaticTypeAcquisition` and `tsserver.automaticTypeAcquisition.enabled: false` under `js/ts`, `typescript` and `javascript`. Checked with TypeScript 5.9.3 and 7.0.2: nothing is installed.
- **pyright:** `python.analysis.extraPaths = ["src"]` when the root has a `src/` layout (`src/<pkg>/__init__.py` and no `src/__init__.py`).
- **pyright, with the opt-in only:** `python.pythonPath` = `<root>/.venv` or `<root>/venv` interpreter.

A `pyrightconfig.json` or `[tool.pyright]` in the project takes precedence over these, and the configuration says so. Nothing is ever written to the repository.

## Security

Language servers are programs run on the user's machine against code under review (design reference §14.2).
- **Opt-in servers.** jdtls imports Maven and Gradle builds, which runs build scripts and plugins. rust-analyzer runs `build.rs` and procedural macros. Both need `allowProjectCode`. Without it, the language reports `needs-opt-in` and the server is not started.
- **pyright** runs a Python interpreter to find import paths. By default that is `python3` or `python` on `PATH`, the user's own. A repository virtualenv interpreter is project-controlled, so we only point pyright at it with the opt-in. A repository `pyrightconfig.json` or `[tool.pyright]` cannot choose the interpreter: `venvPath`/`venv` make pyright read that venv's `site-packages` as files without running it, and `pythonPath` is not a config-file setting (checked with pyright 1.1.414). **Known gap:** that config still chooses what pyright reads (`venv`, `extraPaths`, `stubPath`), so a change can feed it misleading stubs and hide references. That affects accuracy, not code execution.
- **The project's own `node_modules`** (TypeScript, typescript-language-server, pyright) is preferred, as ADR 0001 decided, but only when it is the user's own install. Without the opt-in it is passed over, and the configuration says why, when:
  - Git tracks anything under it (`git ls-files -- node_modules`): a reviewed change could alter it;
  - it, or a top-level package in it, links into the repository outside `node_modules` (npm, yarn and pnpm workspaces and `file:` dependencies). tsserver loads `tsconfig.json` plugins from the `node_modules` its TypeScript sits in, and the reviewed change controls both `tsconfig.json` and those packages' source;
  - the check fails (not a Git repository, Git missing): we refuse rather than guess.

  Servers on `PATH` are used instead, if any. A `PATH` TypeScript loads plugins from its own install, not the project.
- **`PATH`.** Without the opt-in, relative entries and entries inside the repository (e.g. an activated in-repository virtualenv) are dropped, both for discovery and from the servers' environment, so a server that runs a bare command (pyright runs `python3`) cannot pick up one the change added. On Windows, servers also get `NoDefaultCurrentDirectoryInExePath=1`, so a bare command is not looked up in the working directory, the repository, first. **Not verified on Windows**, and whether every server honours it is up to its process library.
- Servers get the snapshot root as their workspace and nothing else. The client sends no file contents except the files it opens from that root.

## Setup notes

- **TypeScript:** `typescript@latest` is 7.x (Go-native) and has no `tsserver.js`. typescript-language-server then fails unless a TypeScript 5.x/6.x is installed next to it or in the project. TS 7's `tsc --lsp` needs nothing else.
- **Python:** install pyright (`npm i -g pyright`, or in the project). Projects need their dependencies where pyright finds them (the active `python`, or the project's settings). `src/` layouts are handled automatically. The PyPI `pyright` wrapper downloads the npm package on first use; that download is outside our control.
- **Java:** jdtls 1.62 needs a Java 25 runtime (#42). Not tested here: there's no JDK on the development machine.
- **Rust:** `rustup component add rust-analyzer`. Not tested.

## Tests

- `analyze.test.ts`, `hits.test.ts` and `snapshot-files.test.ts` run the candidate pipeline on real two-commit repositories through the Git extractor and the structural analyzer, with the signature fixture in `fixture.test-helper.ts`. LSP answers there come from a fake provider.
- The other `*.test.ts` run the LSP tier against an in-process fake server: protocol, readiness, normalisation, overrides, crashes, health.
- `servers.integration.test.ts` runs the real servers on the #3/#4 signature fixture, and `analyze.integration.test.ts` runs the whole #17 pipeline with them. Each suite is **skipped when its server isn't installed**, so the main CI job passes without servers.
- **`npm run test:lsp`** installs pinned servers from `test/lsp-servers/` (typescript-language-server 6.0.2 with TypeScript 5.9.3, pyright 1.1.414, and TypeScript 7.0.2 on its own) and runs both suites against them. It sets `BCR_LSP_REQUIRED`, so a server that didn't install fails the run rather than skipping it. The `lsp` CI job runs it on every push and PR. To change a version, edit that directory's `package.json` and run `npm install` there to update its lockfile.
- To use other servers, put them on `PATH`, or list directories in `BCR_LSP_TEST_PATH`. `servers.integration` tries each directory on its own, so tsserver and TS 7 can both run; `analyze.integration` uses the first one with a server. For example:

```bash
BCR_LSP_TEST_PATH=/a/node_modules/.bin:/b/node_modules/.bin npx vitest run servers.integration
```
