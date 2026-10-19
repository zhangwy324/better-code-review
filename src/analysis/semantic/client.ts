// A minimal LSP client over one server process: initialisation, capability checks, document
// sync, progress and diagnostics tracking. Which requests to make, and how to read their answers,
// lives in session.ts.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JsonRpcConnection } from './jsonrpc.ts';
import type { Diagnostic } from './protocol.ts';

/** The parts of a child process the client uses; tests substitute an in-process fake. */
export interface ServerProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable | null;
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  once(event: 'error', listener: (err: Error) => void): unknown;
  kill(): boolean;
}

export type Spawner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; shell: boolean },
) => ServerProcess;

export const spawnProcess: Spawner = (command, args, options) =>
  spawn(command, args, {
    cwd: options.cwd,
    shell: options.shell,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

/** LSP `languageId` by file extension. */
const LANGUAGE_IDS: Record<string, string> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascriptreact',
  '.py': 'python',
  '.pyi': 'python',
  '.java': 'java',
  '.rs': 'rust',
};

export function languageIdFor(path: string): string {
  return LANGUAGE_IDS[extname(path).toLowerCase()] ?? 'plaintext';
}

export function fileUri(absPath: string): string {
  return pathToFileURL(absPath).href;
}

/** What we tell servers we can do. Everything else is left out, so servers don't send it. */
const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ['utf-16'] },
  window: { workDoneProgress: true },
  workspace: { configuration: true, workspaceFolders: true },
  textDocument: {
    synchronization: { didSave: false },
    definition: { linkSupport: true },
    typeDefinition: { linkSupport: true },
    implementation: { linkSupport: true },
    references: {},
    callHierarchy: {},
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    publishDiagnostics: {},
    diagnostic: {},
  },
};

/** Server capability keys, keyed by the request that needs them. */
const PROVIDERS: Record<string, string> = {
  'textDocument/references': 'referencesProvider',
  'textDocument/definition': 'definitionProvider',
  'textDocument/typeDefinition': 'typeDefinitionProvider',
  'textDocument/implementation': 'implementationProvider',
  'textDocument/prepareCallHierarchy': 'callHierarchyProvider',
  'textDocument/documentSymbol': 'documentSymbolProvider',
  'textDocument/diagnostic': 'diagnosticProvider',
};

export interface InitializeOptions {
  root: string;
  /** Sent as `initializationOptions`. */
  initializationOptions: unknown;
  /** Answers `workspace/configuration`, looked up by dotted section (e.g. `python.analysis`). */
  settings: Record<string, unknown>;
  timeoutMs: number;
}

export class LspClient {
  readonly connection: JsonRpcConnection;
  readonly #process: ServerProcess;
  #capabilities: Record<string, unknown> = {};
  #serverInfo: { name: string; version: string | null } | null = null;
  readonly #registered = new Set<string>();
  readonly #activeProgress = new Set<string | number>();
  readonly #statuses = new Set<string>();
  readonly #diagnostics = new Map<string, Diagnostic[]>();
  readonly #diagnosticWaiters = new Map<string, (() => void)[]>();
  readonly #opened = new Set<string>();
  #exit: string | null = null;
  #stderrTail = '';
  #root = '';

  constructor(process: ServerProcess) {
    this.#process = process;
    this.connection = new JsonRpcConnection(process.stdout, process.stdin);
    process.stderr?.on('data', (chunk: Buffer) => {
      this.#stderrTail = (this.#stderrTail + chunk.toString('utf8')).slice(-2000);
    });
    process.once('exit', (code, signal) => this.#onExit(`exited (code ${code}, signal ${signal})`));
    process.once('error', (err) => this.#onExit(`could not start: ${err.message}`));
    this.#handleServerMessages();
  }

  /** Why the server stopped, with the end of its stderr, or null while it runs. */
  get exitReason(): string | null {
    if (this.#exit === null) return null;
    const tail = this.#stderrTail.trim().split('\n').slice(-3).join(' | ');
    return tail ? `${this.#exit}: ${tail}` : this.#exit;
  }

  get serverInfo(): { name: string; version: string | null } | null {
    return this.#serverInfo;
  }

  /** True while any `$/progress` work started by the server has not ended. */
  get busy(): boolean {
    return this.#activeProgress.size > 0;
  }

  /** `language/status` types seen so far (jdtls: `Starting`, `ServiceReady`, ...). */
  hasStatus(type: string): boolean {
    return this.#statuses.has(type);
  }

  async initialize(options: InitializeOptions): Promise<void> {
    this.#root = options.root;
    const settings = options.settings;
    this.connection.onRequest('workspace/configuration', (params) =>
      ((params as { items?: { section?: string }[] }).items ?? []).map(
        (item) => lookup(settings, item.section) ?? {},
      ),
    );
    const uri = fileUri(options.root);
    const result = await this.connection.request<{
      capabilities?: Record<string, unknown>;
      serverInfo?: { name: string; version?: string };
    }>(
      'initialize',
      {
        processId: process.pid,
        clientInfo: { name: 'better-code-review' },
        rootUri: uri,
        rootPath: options.root,
        workspaceFolders: [{ uri, name: 'root' }],
        initializationOptions: options.initializationOptions,
        capabilities: CLIENT_CAPABILITIES,
      },
      options.timeoutMs,
    );
    this.#capabilities = result.capabilities ?? {};
    if (result.serverInfo) {
      this.#serverInfo = {
        name: result.serverInfo.name,
        version: result.serverInfo.version ?? null,
      };
    }
    this.connection.notify('initialized', {});
    if (Object.keys(settings).length) {
      this.connection.notify('workspace/didChangeConfiguration', { settings });
    }
  }

  /** Whether the server advertised (or dynamically registered) the provider `method` needs. */
  supports(method: string): boolean {
    if (this.#registered.has(method)) return true;
    const key = PROVIDERS[method];
    if (key === undefined) return true;
    const value = this.#capabilities[key];
    return value !== undefined && value !== null && value !== false;
  }

  /** Opens a file from disk once. The snapshot does not change while we query it. */
  open(absPath: string): void {
    const uri = fileUri(absPath);
    if (this.#opened.has(uri)) return;
    this.#opened.add(uri);
    this.connection.notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: languageIdFor(absPath),
        version: 1,
        text: readFileSync(absPath, 'utf8'),
      },
    });
  }

  request<T>(method: string, absPath: string, extra: object, timeoutMs: number): Promise<T> {
    this.open(absPath);
    return this.connection.request<T>(
      method,
      { textDocument: { uri: fileUri(absPath) }, ...extra },
      timeoutMs,
    );
  }

  /** Pushed diagnostics for a file, or undefined if the server has not published any yet. */
  publishedDiagnostics(absPath: string): Diagnostic[] | undefined {
    return this.#diagnostics.get(fileUri(absPath));
  }

  /** Resolves when the server next publishes diagnostics for the file, or after `timeoutMs`. */
  waitForDiagnostics(absPath: string, timeoutMs: number): Promise<void> {
    const uri = fileUri(absPath);
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      const waiters = this.#diagnosticWaiters.get(uri) ?? [];
      waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
      this.#diagnosticWaiters.set(uri, waiters);
    });
  }

  /** Polite shutdown, then kill. Never throws. */
  async stop(timeoutMs = 5000): Promise<void> {
    if (this.#exit === null && !this.connection.closed) {
      try {
        await this.connection.request('shutdown', null, timeoutMs);
        this.connection.notify('exit', null);
      } catch {
        // Killed below either way.
      }
    }
    this.connection.close('client stopped');
    this.#process.kill();
  }

  get root(): string {
    return this.#root;
  }

  #onExit(reason: string): void {
    if (this.#exit === null) this.#exit = reason;
    this.connection.close(`server ${reason}`);
  }

  #handleServerMessages(): void {
    const c = this.connection;
    c.onRequest('window/workDoneProgress/create', () => null);
    c.onRequest('window/showMessageRequest', () => null);
    c.onRequest('workspace/workspaceFolders', () => [{ uri: fileUri(this.#root), name: 'root' }]);
    c.onRequest('client/registerCapability', (params) => {
      for (const r of (params as { registrations?: { method: string }[] }).registrations ?? []) {
        this.#registered.add(r.method);
      }
      return null;
    });
    c.onRequest('client/unregisterCapability', () => null);
    c.onNotification('$/progress', (params) => {
      const { token, value } = params as { token: string | number; value?: { kind?: string } };
      if (value?.kind === 'begin') this.#activeProgress.add(token);
      if (value?.kind === 'end') this.#activeProgress.delete(token);
    });
    c.onNotification('language/status', (params) => {
      const type = (params as { type?: string }).type;
      if (type) this.#statuses.add(type);
    });
    c.onNotification('textDocument/publishDiagnostics', (params) => {
      const { uri, diagnostics } = params as { uri: string; diagnostics: Diagnostic[] };
      // Servers differ in URI spelling (e.g. `c%3A` vs `C:`); key by our own spelling.
      const key = normaliseUri(uri);
      this.#diagnostics.set(key, diagnostics);
      const waiters = this.#diagnosticWaiters.get(key) ?? [];
      this.#diagnosticWaiters.delete(key);
      for (const wake of waiters) wake();
    });
  }
}

/** Re-spells a `file:` URI the way `pathToFileURL` does, so URIs from servers compare equal. */
export function normaliseUri(uri: string): string {
  try {
    return fileUri(fileUriToPath(uri));
  } catch {
    return uri;
  }
}

/** `fileURLToPath`, but accepting a percent-encoded drive (`file:///c%3A/x`, sent by some servers). */
export function fileUriToPath(uri: string): string {
  const path = fileURLToPath(uri.replace(/^file:\/\/\/([a-zA-Z])%3a/i, 'file:///$1:'));
  return /^[a-z]:/.test(path) ? path[0]!.toUpperCase() + path.slice(1) : path;
}

function lookup(settings: Record<string, unknown>, section: string | undefined): unknown {
  if (!section) return settings;
  let value: unknown = settings;
  for (const part of section.split('.')) {
    if (typeof value !== 'object' || value === null) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
