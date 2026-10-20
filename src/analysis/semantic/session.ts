// The semantic analyzer's LSP tier (#16): starts the installed servers a review needs, asks them
// for references with the readiness, constructor and override rules from #4 and #42, checks
// project health, and reports per-language capability. LSP is optional: nothing here throws for
// a missing, broken or slow server; it reports a capability gap or an `unknown` answer instead.
import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { EntityKind, LanguageCapability, SourceRange } from '../../schemas/index.ts';
import { fileUriToPath, LspClient, normaliseUri, type Spawner, spawnProcess } from './client.ts';
import { ErrorCodes, RpcError } from './jsonrpc.ts';
import {
  countImports,
  isAliasDeclaration,
  isConstructorCall,
  isImportLine,
  isMethodDeclaration,
  isUnresolvedImport,
  receiverOf,
  toSourceRange,
  typeNameAt,
} from './normalise.ts';
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  Diagnostic,
  Location,
  LocationLink,
  Position,
  Range,
} from './protocol.ts';
import {
  checkProjectPackages,
  type DiscoveryContext,
  type Launch,
  overrideLaunch,
  type ServerId,
  type ServerOverride,
  type ServerSpec,
  safeSearchPath,
  serverFor,
} from './servers.ts';

type LspCapability = LanguageCapability['failures'][number]['capability'];

export interface LspTimeouts {
  /** Server start-up, up to the `initialize` answer. */
  initializeMs: number;
  /** Any single request. */
  requestMs: number;
  /** How long one query may wait for the server to be ready and give a stable answer. */
  readyMs: number;
  /** An empty answer is only believed this long after the server started (#4). */
  emptyGraceMs: number;
  /** Pause between repeated `references` requests while waiting for a stable answer. */
  retryDelayMs: number;
  /** How long to wait for a file's diagnostics in the health check. */
  healthMs: number;
}

export const DEFAULT_TIMEOUTS: LspTimeouts = {
  initializeMs: 60_000,
  requestMs: 30_000,
  readyMs: 60_000,
  emptyGraceMs: 10_000,
  retryDelayMs: 1_000,
  healthMs: 30_000,
};

/** Options for the LSP tier. README.md documents each one. */
export interface LspOptions {
  /** Default true. False reports every language as `disabled` and starts nothing. */
  enabled?: boolean;
  /** Allow servers and interpreters that run project code (D11). Default false. */
  allowProjectCode?: boolean;
  /** Replace discovery for a server with an explicit command. */
  servers?: Partial<Record<ServerId, ServerOverride>>;
  timeouts?: Partial<LspTimeouts>;
  /** How many times a crashed server is restarted. Default 1. */
  maxRestarts?: number;
  /** Largest share of unresolved imports at which the project still counts as healthy. Default 0. */
  maxUnresolvedImportShare?: number;
  /** The `PATH` searched for servers. Default `process.env.PATH`. */
  searchPath?: string;
  /** How server processes are started. Tests pass a fake. */
  spawn?: Spawner;
}

/** A position in a file, 1-based like `SourceRange`. */
export interface FilePosition {
  /** Repository-relative, `/`-separated. */
  path: string;
  line: number;
  /** 1-based, UTF-16 code units. */
  column: number;
}

/** What to find references to. */
export interface ReferenceTarget extends FilePosition {
  /** Grammar name, as in `AnalyzedFile.language`. */
  language: string;
  /**
   * Position of the entity's name. For a `constructor` (including Python `__init__`), the
   * position of the class name: references are asked of the class, and only call sites kept.
   */
  kind: EntityKind;
  /** For an override: the base methods it overrides, queried too (#42). */
  baseMethods?: FilePosition[];
  /**
   * For an override: the types whose receivers can reach it, i.e. its class, its subclasses
   * and its ancestors. A call through a base method is kept only when the receiver's static
   * type is one of these; without the list such calls are returned as `unresolved`.
   */
  receiverTypes?: string[];
}

export interface ReferenceSite {
  /** Repository-relative, `/`-separated. */
  path: string;
  range: SourceRange;
  /** `base-method`: a call through an overridden base method whose receiver can reach it. */
  via: 'direct' | 'base-method';
}

export type ReferencesResult =
  | {
      status: 'ok';
      /** Import lines are left out for every server (normalise.ts, `isImportLine`). */
      references: ReferenceSite[];
      /** Calls through a base method whose receiver type could not be decided. */
      unresolved: ReferenceSite[];
      /** False when a base-method query failed: some calls may be missing. */
      complete: boolean;
    }
  /** Not "no references": the server was missing, not ready, or failed (ADR 0001). */
  | { status: 'unknown'; reason: string };

export interface ProjectHealth {
  /** Whether a reference the server did not return may be treated as a rejection (#42). */
  healthy: boolean;
  imports: number;
  unresolved: { path: string; line: number; message: string }[];
  reason: string | null;
}

interface ServerState {
  spec: ServerSpec;
  launch: Launch | null;
  client: LspClient | null;
  /** The status decided at start-up; runtime problems are added in `capabilities()`. */
  status: LanguageCapability['status'];
  guidance: string | null;
  attempted: Set<LspCapability>;
  failures: Map<string, { capability: LspCapability; message: string }>;
  restarts: number;
  startedAt: number;
  answered: boolean;
  notReady: string | null;
  unhealthy: string | null;
}

class NotReadyError extends Error {}

export class LspSession {
  readonly #root: string;
  readonly #options: LspOptions;
  readonly #timeouts: LspTimeouts;
  readonly #languages: string[] = [];
  readonly #states = new Map<ServerId, ServerState>();
  readonly #lines = new Map<string, string[]>();
  readonly #env: NodeJS.ProcessEnv;
  #untrustedPackages: string | null = null;

  private constructor(root: string, options: LspOptions) {
    this.#root = root;
    this.#options = options;
    this.#timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.#env = serverEnv(root, options.allowProjectCode ?? false);
  }

  /**
   * Starts a server for each language that has one installed. Never throws: problems become
   * per-language capability gaps (`capabilities()`).
   * @param root the snapshot's working tree; servers index it as their workspace
   * @param languages grammar names (`AnalyzedFile.language`) of the files under review
   */
  static async start(
    root: string,
    languages: readonly string[],
    options: LspOptions = {},
  ): Promise<LspSession> {
    const session = new LspSession(root, options);
    if (!options.allowProjectCode) session.#untrustedPackages = checkProjectPackages(root);
    const specs = new Set<ServerSpec>();
    for (const language of languages) {
      if (session.#languages.includes(language)) continue;
      session.#languages.push(language);
      const spec = serverFor(language);
      if (spec) specs.add(spec);
    }
    await Promise.all([...specs].map((spec) => session.#startServer(spec)));
    return session;
  }

  /** One entry per language passed to `start()`, in that order (D11). */
  capabilities(): LanguageCapability[] {
    return this.#languages.map((language) => {
      const state = this.#stateFor(language);
      if (!state) {
        return {
          language,
          server: null,
          status: 'not-installed',
          capabilitiesAttempted: [],
          failures: [],
          guidance: `${language} callers: possible only — no supported language server`,
        };
      }
      const { status, guidance } = this.#runtimeStatus(state);
      const used = state.client !== null && state.launch !== null;
      return {
        language,
        server: used
          ? {
              name: state.launch!.name,
              version: state.client!.serverInfo?.version ?? state.launch!.version,
              configuration: state.launch!.configuration,
            }
          : null,
        status,
        capabilitiesAttempted: [...state.attempted].sort(),
        failures: [...state.failures.values()],
        guidance,
      };
    });
  }

  /**
   * References to a changed entity, following #42: readiness (two identical answers, or
   * `ServiceReady`), a call-hierarchy cross-check, constructors through the class name, and
   * calls through overridden base methods filtered by receiver type.
   */
  async references(target: ReferenceTarget): Promise<ReferencesResult> {
    const state = this.#stateFor(target.language);
    if (!state?.client) {
      return { status: 'unknown', reason: `no ${target.language} language server is running` };
    }
    try {
      return await this.#withClient(state, (client) => this.#references(state, client, target));
    } catch (err) {
      return { status: 'unknown', reason: (err as Error).message };
    }
  }

  /**
   * Checks the share of unresolved imports in the files involved (#42: pyright silently
   * returned 4 of 37 references when `src/` was not on its path). Only when healthy may a
   * reference the server did not return be treated as a rejection.
   */
  async projectHealth(language: string, paths: readonly string[]): Promise<ProjectHealth> {
    const state = this.#stateFor(language);
    if (!state?.client) {
      return unhealthy(`no ${language} language server is running`);
    }
    try {
      return await this.#withClient(state, (client) => this.#projectHealth(state, client, paths));
    } catch (err) {
      return unhealthy((err as Error).message);
    }
  }

  /** Shuts every server down. */
  async close(): Promise<void> {
    await Promise.all([...this.#states.values()].map((s) => s.client?.stop() ?? Promise.resolve()));
  }

  // -------------------------------------------------------------------------------------------
  // Start-up and crash recovery

  async #startServer(spec: ServerSpec): Promise<void> {
    const state: ServerState = {
      spec,
      launch: null,
      client: null,
      status: 'ok',
      guidance: null,
      attempted: new Set(),
      failures: new Map(),
      restarts: 0,
      startedAt: 0,
      answered: false,
      notReady: null,
      unhealthy: null,
    };
    this.#states.set(spec.id, state);
    const gap = `${spec.label} callers: possible only`;
    if (this.#options.enabled === false) {
      state.status = 'disabled';
      state.guidance = `${gap} — language servers are turned off for this run`;
      return;
    }
    const allowProjectCode = this.#options.allowProjectCode ?? false;
    const searchPath = this.#options.searchPath ?? process.env.PATH ?? '';
    const ctx: DiscoveryContext = {
      root: this.#root,
      searchPath: allowProjectCode ? searchPath : safeSearchPath(searchPath, this.#root),
      allowProjectCode,
      untrustedPackages: this.#untrustedPackages,
      platform: process.platform,
    };
    const override = this.#options.servers?.[spec.id];
    const found = override ? { launch: overrideLaunch(override, ctx) } : spec.discover(ctx);
    if (!found.launch) {
      state.status = 'not-installed';
      state.guidance = `${gap} — ${found.why}; ${spec.installHint}`;
      return;
    }
    state.launch = found.launch;
    if (spec.runsProjectCode && !ctx.allowProjectCode) {
      state.status = 'needs-opt-in';
      state.guidance = `${gap} — ${spec.runsProjectCode}; allow project code to use it`;
      return;
    }
    try {
      state.client = await this.#spawn(found.launch);
      state.startedAt = Date.now();
    } catch (err) {
      state.status = 'failed';
      state.guidance = `${gap} — ${found.launch.name} failed to start: ${(err as Error).message}`;
    }
  }

  async #spawn(launch: Launch): Promise<LspClient> {
    const spawn = this.#options.spawn ?? spawnProcess;
    const client = new LspClient(
      spawn(launch.command, launch.args, { cwd: this.#root, shell: launch.shell, env: this.#env }),
    );
    try {
      await client.initialize({
        root: this.#root,
        initializationOptions: launch.initializationOptions,
        settings: launch.settings,
        timeoutMs: this.#timeouts.initializeMs,
      });
      return client;
    } catch (err) {
      const reason = client.exitReason ?? (err as Error).message;
      await client.stop(1000);
      throw new Error(reason, { cause: err });
    }
  }

  /** Runs `fn`, restarting a crashed server (up to `maxRestarts`) and retrying once. */
  async #withClient<T>(state: ServerState, fn: (client: LspClient) => Promise<T>): Promise<T> {
    for (;;) {
      const client = await this.#liveClient(state);
      try {
        return await fn(client);
      } catch (err) {
        if (client.exitReason === null || err instanceof NotReadyError) throw err;
        // Crashed mid-request: loop restarts it, or throws when out of restarts.
      }
    }
  }

  async #liveClient(state: ServerState): Promise<LspClient> {
    const client = state.client!;
    if (client.exitReason === null) return client;
    const maxRestarts = this.#options.maxRestarts ?? 1;
    const crash = `${state.launch!.name} ${client.exitReason}`;
    if (state.restarts >= maxRestarts) {
      state.status = 'failed';
      state.guidance = `${state.spec.label} callers: possible only — ${crash}`;
      throw new Error(crash);
    }
    state.restarts++;
    state.failures.set(`crash:${state.restarts}`, { capability: 'references', message: crash });
    try {
      state.client = await this.#spawn(state.launch!);
      state.startedAt = Date.now();
      return state.client;
    } catch (err) {
      state.status = 'failed';
      state.guidance = `${state.spec.label} callers: possible only — restart failed: ${(err as Error).message}`;
      throw err;
    }
  }

  // -------------------------------------------------------------------------------------------
  // References

  async #references(
    state: ServerState,
    client: LspClient,
    target: ReferenceTarget,
  ): Promise<ReferencesResult> {
    if (!this.#supported(state, client, 'textDocument/references', 'references')) {
      return { status: 'unknown', reason: `${state.launch!.name} does not support references` };
    }
    await this.#waitReady(state, client);
    const constructor = target.kind === 'constructor';
    const crossCheck = target.kind === 'function' || target.kind === 'method';
    const direct = await this.#stableReferences(state, client, target, crossCheck);
    const found: [Location, ReferenceSite['via']][] = direct.map((loc) => [loc, 'direct']);
    let complete = true;
    for (const base of target.baseMethods ?? []) {
      try {
        const locations = await this.#stableReferences(state, client, base, false);
        found.push(...locations.map((loc): [Location, 'base-method'] => [loc, 'base-method']));
      } catch (err) {
        if (client.exitReason !== null) throw err;
        complete = false;
      }
    }

    const references: ReferenceSite[] = [];
    const unresolved: ReferenceSite[] = [];
    const seen = new Set<string>();
    for (const [loc, via] of found) {
      const [site] = this.#sites([loc], via, constructor);
      if (!site || seen.has(siteKey(site))) continue;
      seen.add(siteKey(site));
      const verdict =
        target.kind === 'method'
          ? await this.#methodCall(state, client, loc, via, target.receiverTypes)
          : 'keep';
      if (verdict === 'keep') references.push(site);
      if (verdict === 'unresolved') unresolved.push(site);
    }
    state.answered = true;
    return { status: 'ok', references, unresolved, complete };
  }

  /** Waits for jdtls's `ServiceReady`, or for in-flight `$/progress` work to end (bounded). */
  async #waitReady(state: ServerState, client: LspClient): Promise<void> {
    const deadline = Date.now() + this.#timeouts.readyMs;
    if (state.spec.readiness === 'service-ready') {
      while (!client.hasStatus('ServiceReady')) {
        if (Date.now() >= deadline) {
          throw this.#notReady(state, `${state.launch!.name} did not report ServiceReady`);
        }
        await sleep(100);
      }
      return;
    }
    while (client.busy && Date.now() < deadline) await sleep(100);
  }

  /**
   * Asks for references until two consecutive answers are identical (#42). An empty answer is
   * only believed once the server has been up for `emptyGraceMs`, and, for functions and
   * methods, once `callHierarchy/incomingCalls` (correct immediately in #4) agrees.
   */
  async #stableReferences(
    state: ServerState,
    client: LspClient,
    at: FilePosition,
    crossCheck: boolean,
  ): Promise<Location[]> {
    const abs = this.#abs(at.path);
    const position: Position = { line: at.line - 1, character: at.column - 1 };
    const deadline = Date.now() + this.#timeouts.readyMs;
    let previous: string | null = null;
    let disagreement: string | null = null;
    for (;;) {
      let locations: Location[] | null = null;
      try {
        const answer = await client.request<(Location | LocationLink)[] | null>(
          'textDocument/references',
          abs,
          { position, context: { includeDeclaration: false } },
          this.#timeouts.requestMs,
        );
        locations = toLocations(answer);
      } catch (err) {
        // ContentModified: the server is still loading; anything else is a real failure.
        if (!(err instanceof RpcError && err.code === ErrorCodes.ContentModified)) {
          this.#fail(state, 'references', err);
          throw err;
        }
      }
      if (locations) {
        const signature = JSON.stringify(locations.map(locationKey).sort());
        const settled =
          signature === previous &&
          (locations.length > 0 || Date.now() - state.startedAt >= this.#timeouts.emptyGraceMs);
        if (settled) {
          const missing = crossCheck
            ? await this.#missingCallers(state, client, abs, position, locations)
            : 0;
          if (missing === 0) return locations;
          disagreement = `call hierarchy found ${missing} call site(s) that references did not return`;
        }
        previous = signature;
      }
      if (Date.now() >= deadline) {
        const why = disagreement ?? 'references did not give the same answer twice';
        throw this.#notReady(state, `${state.launch!.name} was not ready: ${why}`);
      }
      await sleep(this.#timeouts.retryDelayMs);
    }
  }

  /** Incoming call sites not covered by `locations`; 0 when call hierarchy is unavailable. */
  async #missingCallers(
    state: ServerState,
    client: LspClient,
    abs: string,
    position: Position,
    locations: Location[],
  ): Promise<number> {
    if (!this.#supported(state, client, 'textDocument/prepareCallHierarchy', 'callHierarchy')) {
      return 0;
    }
    let calls: CallHierarchyIncomingCall[] = [];
    try {
      const items = await client.request<CallHierarchyItem[] | null>(
        'textDocument/prepareCallHierarchy',
        abs,
        { position },
        this.#timeouts.requestMs,
      );
      for (const item of items ?? []) {
        const incoming = await client.connection.request<CallHierarchyIncomingCall[] | null>(
          'callHierarchy/incomingCalls',
          { item },
          this.#timeouts.requestMs,
        );
        calls.push(...(incoming ?? []));
      }
    } catch (err) {
      if (client.exitReason !== null) throw err;
      this.#fail(state, 'callHierarchy', err);
      calls = [];
    }
    const covered = new Set(locations.map((l) => `${normaliseUri(l.uri)}:${l.range.start.line}`));
    let missing = 0;
    for (const call of calls) {
      for (const range of call.fromRanges) {
        if (!covered.has(`${normaliseUri(call.from.uri)}:${range.start.line}`)) missing++;
      }
    }
    return missing;
  }

  /**
   * Whether a method reference can reach the changed override (#42). tsserver answers for the
   * whole override family (base and sibling declarations, `super.x()`, sibling receivers), and
   * the base-method query does by design, so both go through the same filter:
   * - other declarations of the method are dropped;
   * - with `receiverTypes`, a receiver whose static type is not one of them is dropped;
   * - `super.x()` through a base method is static dispatch to the base and is dropped;
   * - what cannot be decided is `unresolved`, except direct answers, which are trusted.
   */
  async #methodCall(
    state: ServerState,
    client: LspClient,
    loc: Location,
    via: ReferenceSite['via'],
    receiverTypes: readonly string[] | undefined,
  ): Promise<'keep' | 'drop' | 'unresolved'> {
    const lines = this.#fileLines(fileUriToPath(loc.uri));
    if (isMethodDeclaration(lines, loc.range)) return 'drop';
    const receiver = receiverOf(lines[loc.range.start.line] ?? '', loc.range.start.character);
    const undecided = via === 'direct' ? 'keep' : 'unresolved';
    if (receiver.kind === 'super') return via === 'direct' ? 'unresolved' : 'drop';
    if (receiver.kind !== 'identifier' || !receiverTypes) return undecided;
    const reaches = await this.#receiverReaches(
      state,
      client,
      loc,
      receiver.character,
      receiverTypes,
    );
    if (reaches === null) return 'unresolved';
    return reaches ? 'keep' : 'drop';
  }

  /** Whether the receiver's static type is one of `receiverTypes`, or null if undecided. */
  async #receiverReaches(
    state: ServerState,
    client: LspClient,
    loc: Location,
    character: number,
    receiverTypes: readonly string[],
  ): Promise<boolean | null> {
    const path = fileUriToPath(loc.uri);
    if (!this.#supported(state, client, 'textDocument/typeDefinition', 'typeDefinition')) {
      return null;
    }
    try {
      const answer = await client.request<Location | (Location | LocationLink)[] | null>(
        'textDocument/typeDefinition',
        path,
        { position: { line: loc.range.start.line, character } },
        this.#timeouts.requestMs,
      );
      const first = Array.isArray(answer) ? answer[0] : answer;
      if (!first) return null;
      const [uri, range] =
        'targetUri' in first
          ? [first.targetUri, first.targetSelectionRange]
          : [first.uri, first.range];
      const type = typeNameAt(this.#fileLines(fileUriToPath(uri)), range);
      return type === null ? null : receiverTypes.includes(type);
    } catch (err) {
      if (client.exitReason !== null) throw err;
      this.#fail(state, 'typeDefinition', err);
      return null;
    }
  }

  /** Repository-relative sites, without imports, alias names and files outside the workspace. */
  #sites(locations: Location[], via: ReferenceSite['via'], callsOnly: boolean): ReferenceSite[] {
    const sites: ReferenceSite[] = [];
    for (const loc of locations) {
      let abs: string;
      try {
        abs = fileUriToPath(loc.uri);
      } catch {
        continue;
      }
      const rel = relative(this.#root, abs);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
      const lines = this.#fileLines(abs);
      if (isImportLine(lines, loc.range.start.line)) continue;
      if (isAliasDeclaration(lines, loc.range)) continue;
      if (callsOnly && !isConstructorCall(lines, loc.range)) continue;
      sites.push({ path: rel.split(sep).join('/'), range: toSourceRange(loc.range), via });
    }
    return sites;
  }

  // -------------------------------------------------------------------------------------------
  // Project health

  async #projectHealth(
    state: ServerState,
    client: LspClient,
    paths: readonly string[],
  ): Promise<ProjectHealth> {
    await this.#waitReady(state, client);
    state.attempted.add('diagnostics');
    let imports = 0;
    const unresolved: ProjectHealth['unresolved'] = [];
    for (const path of paths) {
      const abs = this.#abs(path);
      imports += countImports(this.#fileLines(abs).join('\n'));
      const diagnostics = await this.#diagnostics(state, client, abs);
      if (diagnostics === null) {
        const reason = `${state.launch!.name} reported no diagnostics for ${path}, so imports could not be checked`;
        state.unhealthy = reason;
        return unhealthy(reason);
      }
      for (const d of diagnostics.filter(isUnresolvedImport)) {
        unresolved.push({ path, line: d.range.start.line + 1, message: d.message });
      }
    }
    const share = imports === 0 ? 0 : unresolved.length / imports;
    const healthy = share <= (this.#options.maxUnresolvedImportShare ?? 0);
    const reason = healthy
      ? null
      : `${unresolved.length} of ${imports} imports in the files involved do not resolve (first: ${unresolved[0]!.path}:${unresolved[0]!.line} ${unresolved[0]!.message})`;
    // A later healthy check of other files does not clear it: those files are fine, these not.
    state.unhealthy ??= reason;
    return { healthy, imports, unresolved, reason };
  }

  /** Pulled diagnostics when the server supports them, else the next pushed set. */
  async #diagnostics(
    state: ServerState,
    client: LspClient,
    abs: string,
  ): Promise<Diagnostic[] | null> {
    if (client.supports('textDocument/diagnostic')) {
      try {
        const report = await client.request<{ items?: Diagnostic[] } | null>(
          'textDocument/diagnostic',
          abs,
          {},
          this.#timeouts.requestMs,
        );
        return report?.items ?? [];
      } catch (err) {
        if (client.exitReason !== null) throw err;
        this.#fail(state, 'diagnostics', err);
      }
    }
    const published = client.publishedDiagnostics(abs);
    if (published) return published;
    const waiting = client.waitForDiagnostics(abs, this.#timeouts.healthMs);
    client.open(abs);
    await waiting;
    return client.publishedDiagnostics(abs) ?? null;
  }

  // -------------------------------------------------------------------------------------------
  // Helpers

  #stateFor(language: string): ServerState | undefined {
    const spec = serverFor(language);
    return spec ? this.#states.get(spec.id) : undefined;
  }

  #runtimeStatus(state: ServerState): Pick<LanguageCapability, 'status' | 'guidance'> {
    if (state.status !== 'ok') return { status: state.status, guidance: state.guidance };
    const gap = `${state.spec.label} callers: possible only`;
    if (state.notReady && !state.answered) {
      return { status: 'not-ready', guidance: `${gap} — ${state.notReady}` };
    }
    if (state.unhealthy) {
      return {
        status: 'unhealthy',
        guidance: `${state.spec.label}: in files whose imports do not resolve, references the server did not return are not rejections — ${state.unhealthy}. ${state.spec.healthHint}`,
      };
    }
    return { status: 'ok', guidance: null };
  }

  #supported(
    state: ServerState,
    client: LspClient,
    method: string,
    capability: LspCapability,
  ): boolean {
    state.attempted.add(capability);
    if (client.supports(method)) return true;
    state.failures.set(`unsupported:${capability}`, {
      capability,
      message: `${state.launch!.name} does not support ${method}`,
    });
    return false;
  }

  #fail(state: ServerState, capability: LspCapability, err: unknown): void {
    const message =
      err instanceof RpcError && err.code === ErrorCodes.MethodNotFound
        ? `${state.launch!.name} does not support ${capability}`
        : (err as Error).message;
    state.failures.set(`${capability}:${message}`, { capability, message });
  }

  #notReady(state: ServerState, reason: string): NotReadyError {
    state.notReady = `${reason} within ${this.#timeouts.readyMs / 1000} s`;
    return new NotReadyError(state.notReady);
  }

  #abs(path: string): string {
    return join(this.#root, ...path.split('/'));
  }

  #fileLines(abs: string): string[] {
    let lines = this.#lines.get(abs);
    if (!lines) {
      try {
        lines = readFileSync(abs, 'utf8').split(/\r?\n/);
      } catch {
        lines = [];
      }
      this.#lines.set(abs, lines);
    }
    return lines;
  }
}

/**
 * The environment servers run in. Without the opt-in, `PATH` loses relative and in-repository
 * entries, so a server that runs a bare command (pyright runs `python3`) cannot pick up one the
 * reviewed change put in the repository.
 */
function serverEnv(root: string, allowProjectCode: boolean): NodeJS.ProcessEnv {
  if (allowProjectCode) return process.env;
  const env = { ...process.env };
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  env[key] = safeSearchPath(env[key] ?? '', root);
  // Windows also searches the working directory, the repository, for a bare command first.
  if (process.platform === 'win32') env.NoDefaultCurrentDirectoryInExePath = '1';
  return env;
}

function unhealthy(reason: string): ProjectHealth {
  return { healthy: false, imports: 0, unresolved: [], reason };
}

function toLocations(answer: (Location | LocationLink)[] | null): Location[] {
  return (answer ?? []).map((l) =>
    'targetUri' in l ? { uri: l.targetUri, range: l.targetSelectionRange } : l,
  );
}

function locationKey(l: Location): string {
  const r: Range = l.range;
  return `${normaliseUri(l.uri)}:${r.start.line}:${r.start.character}:${r.end.line}:${r.end.character}`;
}

function siteKey(s: ReferenceSite): string {
  return `${s.path}:${s.range.startLine}:${s.range.startColumn}`;
}
