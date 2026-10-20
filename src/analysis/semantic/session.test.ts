// The session against a scripted in-process server: readiness, normalisation, constructors,
// overrides, capability reporting, crash recovery and the health check.
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerProcess } from './client.ts';
import { encodeMessage, ErrorCodes, type JsonRpcMessage, MessageReader } from './jsonrpc.ts';
import type { Location } from './protocol.ts';
import { type LspOptions, LspSession, type ReferencesResult } from './session.ts';

const FILES: Record<string, string> = {
  'src/price.ts': 'export function formatPrice(amount: number) {\n  return String(amount);\n}\n',
  'src/checkout.ts':
    "import { formatPrice } from './price';\n\nexport function checkoutSummary(t: number) {\n  return formatPrice(t);\n}\n",
  'src/reexport.ts': "export { formatPrice as fmt } from './price';\n",
  'src/shapes.ts': [
    'export class Shape {',
    '  area(): number {',
    '    return 0;',
    '  }',
    '}',
    'export class Square extends Shape {',
    '  override area(): number {',
    '    return super.area();',
    '  }',
    '}',
    'export class Circle extends Shape {}',
    'export function use(s: Shape, q: Square, c: Circle, sq: Square[]) {',
    '  const n = new Square();',
    '  return s.area() + q.area() + c.area() + sq[0].area();',
    '}',
    '',
  ].join('\n'),
  'src/broken.ts': "import { x } from 'missing-package';\nimport { y } from './y';\n",
  // Stripe.refund's receivers (#80): Paypal and Adyen are siblings; Connect is a subclass, Root
  // a further ancestor, Refunder an interface, and a union is not settled.
  'src/gateways.ts': [
    'export interface Gateway {',
    '  refund(): void;',
    '}',
    'export class Root implements Gateway {',
    '  refund(): void {}',
    '}',
    'export class Mid extends Root {}',
    'export class Stripe extends Mid implements Gateway {',
    '  override refund(): void {}',
    '}',
    'export class Paypal implements Gateway {',
    '  refund(): void {}',
    '}',
    'export class Connect extends Stripe {}',
    'export class Adyen extends Paypal {}',
    'export interface Refunder extends Gateway {}',
    'export function use(p: Paypal, k: Connect, a: Adyen, r: Root, i: Refunder, u: Paypal | Adyen) {',
    '  p.refund(); k.refund(); a.refund(); r.refund(); i.refund(); u.refund();',
    '}',
    'export class Express extends Stripe {',
    '  override refund(): void {}',
    '}',
    'export function useExpress(e: Express) {',
    '  e.refund();',
    '}',
    '',
  ].join('\n'),
};

const root = mkdtempSync(join(tmpdir(), 'bcr-session-'));
beforeAll(() => {
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const uri = (rel: string) => pathToFileURL(join(root, rel)).href;

/** The location of the `nth` occurrence of `name` in a fixture file. */
function loc(rel: string, name: string, nth = 0): Location {
  const lines = FILES[rel]!.split('\n');
  let seen = 0;
  for (let line = 0; line < lines.length; line++) {
    for (let i = lines[line]!.indexOf(name); i >= 0; i = lines[line]!.indexOf(name, i + 1)) {
      if (seen++ === nth) {
        return {
          uri: uri(rel),
          range: { start: { line, character: i }, end: { line, character: i + name.length } },
        };
      }
    }
  }
  throw new Error(`${name} #${nth} not in ${rel}`);
}

type Handler = (params: Record<string, unknown>, server: FakeServer) => unknown;

const CAPABILITIES = {
  referencesProvider: true,
  callHierarchyProvider: true,
  typeDefinitionProvider: true,
};

/** A language server in memory, speaking real LSP framing over streams. */
class FakeServer extends EventEmitter implements ServerProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: string[] = [];
  readonly #handlers: Record<string, Handler>;

  constructor(handlers: Record<string, Handler>, capabilities: object = CAPABILITIES) {
    super();
    this.#handlers = {
      initialize: () => ({ capabilities, serverInfo: { name: 'fake', version: '1.0' } }),
      shutdown: () => null,
      ...handlers,
    };
    const reader = new MessageReader();
    this.stdin.on('data', (chunk: Buffer) => {
      for (const m of reader.push(chunk)) void this.#receive(m);
    });
  }

  async #receive(m: JsonRpcMessage): Promise<void> {
    if (m.method === undefined) return;
    this.requests.push(m.method);
    const handler = this.#handlers[m.method];
    if (m.id === undefined) {
      handler?.((m.params ?? {}) as Record<string, unknown>, this);
      return;
    }
    if (!handler) {
      return this.send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } });
    }
    try {
      const result = await handler((m.params ?? {}) as Record<string, unknown>, this);
      this.send({ jsonrpc: '2.0', id: m.id, result: result ?? null });
    } catch (err) {
      const { code = -32603, message } = err as { code?: number; message: string };
      this.send({ jsonrpc: '2.0', id: m.id, error: { code, message } });
    }
  }

  send(m: JsonRpcMessage): void {
    if (!this.stdout.writableEnded) this.stdout.write(encodeMessage(m));
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  crash(): void {
    this.stdout.end();
    this.emit('exit', 1, null);
  }

  kill(): boolean {
    this.emit('exit', null, 'SIGTERM');
    return true;
  }
}

const FAST = {
  initializeMs: 1000,
  requestMs: 500,
  readyMs: 300,
  emptyGraceMs: 0,
  retryDelayMs: 5,
  healthMs: 200,
};

async function start(
  make: () => FakeServer,
  options: LspOptions = {},
  languages = ['typescript'],
): Promise<{ session: LspSession; servers: FakeServer[] }> {
  const servers: FakeServer[] = [];
  const session = await LspSession.start(root, languages, {
    servers: { typescript: { command: 'fake-ls' }, java: { command: 'fake-jdtls' } },
    spawn: () => {
      const server = make();
      servers.push(server);
      return server;
    },
    ...options,
    timeouts: { ...FAST, ...options.timeouts },
  });
  return { session, servers };
}

/** A `references` handler that returns each answer in turn, repeating the last. */
function answers(...list: (Location[] | Error)[]): Handler {
  let i = 0;
  return () => {
    const answer = list[Math.min(i++, list.length - 1)]!;
    if (answer instanceof Error) throw answer;
    return answer;
  };
}

const formatPrice = {
  language: 'typescript',
  path: 'src/price.ts',
  line: 1,
  column: 17,
  kind: 'function' as const,
};

function paths(result: ReferencesResult): string[] {
  if (result.status !== 'ok') throw new Error(result.reason);
  return result.references.map((r) => `${r.path}:${r.range.startLine}:${r.range.startColumn}`);
}

describe('readiness', () => {
  const call = loc('src/checkout.ts', 'formatPrice', 1);

  it('waits for two identical answers', async () => {
    const other = loc('src/reexport.ts', 'formatPrice');
    const { session, servers } = await start(
      () =>
        new FakeServer(
          { 'textDocument/references': answers([call], [call, other], [call, other]) },
          { referencesProvider: true },
        ),
    );
    expect(paths(await session.references(formatPrice))).toEqual([
      'src/checkout.ts:4:10',
      'src/reexport.ts:1:10',
    ]);
    expect(servers[0]!.requests.filter((m) => m === 'textDocument/references')).toHaveLength(3);
    await session.close();
  });

  it('does not believe an empty answer while call hierarchy finds callers', async () => {
    const item = { name: 'formatPrice', ...loc('src/price.ts', 'formatPrice') };
    const { session } = await start(
      () =>
        new FakeServer({
          'textDocument/references': answers([], [], [], [call]),
          'textDocument/prepareCallHierarchy': () => [{ ...item, selectionRange: item.range }],
          'callHierarchy/incomingCalls': () => [
            {
              from: {
                name: 'checkoutSummary',
                uri: call.uri,
                range: call.range,
                selectionRange: call.range,
              },
              fromRanges: [call.range],
            },
          ],
        }),
    );
    expect(paths(await session.references(formatPrice))).toEqual(['src/checkout.ts:4:10']);
    await session.close();
  });

  it('reports not-ready, not "no references", when the server never settles', async () => {
    const { session } = await start(
      () => new FakeServer({ 'textDocument/references': () => [] }, { referencesProvider: true }),
      { timeouts: { emptyGraceMs: 60_000 } },
    );
    const result = await session.references(formatPrice);
    expect(result.status).toBe('unknown');
    const [cap] = session.capabilities();
    expect(cap!.status).toBe('not-ready');
    expect(cap!.guidance).toMatch(/did not give the same answer twice/);
    await session.close();
  });

  it('accepts an empty answer after the grace period when call hierarchy agrees', async () => {
    const { session } = await start(
      () =>
        new FakeServer({
          'textDocument/references': () => [],
          'textDocument/prepareCallHierarchy': () => [],
        }),
    );
    const result = await session.references(formatPrice);
    expect(result).toEqual({
      status: 'ok',
      references: [],
      unresolved: [],
      excluded: [],
      complete: true,
    });
    await session.close();
  });

  it('retries while the server answers ContentModified', async () => {
    const busy = Object.assign(new Error('busy'), { code: ErrorCodes.ContentModified });
    const { session } = await start(
      () =>
        new FakeServer(
          { 'textDocument/references': answers(busy, busy, [call]) },
          { referencesProvider: true },
        ),
    );
    expect(paths(await session.references(formatPrice))).toEqual(['src/checkout.ts:4:10']);
    await session.close();
  });

  it("waits for jdtls's ServiceReady before asking", async () => {
    const make = (ready: boolean) => () =>
      new FakeServer(
        {
          initialized: (_, server) => {
            if (ready)
              setTimeout(() => server.notify('language/status', { type: 'ServiceReady' }), 30);
          },
          'textDocument/references': () => [loc('src/checkout.ts', 'formatPrice', 1)],
        },
        { referencesProvider: true },
      );
    const target = { ...formatPrice, language: 'java' };
    const ready = await start(make(true), { allowProjectCode: true }, ['java']);
    expect(paths(await ready.session.references(target))).toEqual(['src/checkout.ts:4:10']);
    await ready.session.close();

    const never = await start(make(false), { allowProjectCode: true }, ['java']);
    const result = await never.session.references(target);
    expect(result).toMatchObject({ status: 'unknown', reason: /ServiceReady/ });
    expect(never.servers[0]!.requests).not.toContain('textDocument/references');
    await never.session.close();
  });
});

describe('normalisation', () => {
  it('drops import lines, alias names and files outside the workspace', async () => {
    const outside = {
      ...loc('src/price.ts', 'formatPrice'),
      uri: pathToFileURL(join(tmpdir(), 'x.ts')).href,
    };
    const refs = [
      loc('src/checkout.ts', 'formatPrice', 0), // import
      loc('src/checkout.ts', 'formatPrice', 1), // call
      loc('src/reexport.ts', 'formatPrice'), // re-export: kept
      loc('src/reexport.ts', 'fmt'), // alias name: tsserver only
      outside,
    ];
    const { session } = await start(
      () => new FakeServer({ 'textDocument/references': () => refs }, { referencesProvider: true }),
    );
    expect(paths(await session.references(formatPrice))).toEqual([
      'src/checkout.ts:4:10',
      'src/reexport.ts:1:10',
    ]);
    await session.close();
  });

  it('keeps only call sites for a constructor queried through its class', async () => {
    const refs = [
      loc('src/shapes.ts', 'Square', 1), // `q: Square`
      loc('src/shapes.ts', 'Square', 2), // `sq: Square[]`
      loc('src/shapes.ts', 'Square', 3), // `new Square()`
    ];
    const { session } = await start(
      () => new FakeServer({ 'textDocument/references': () => refs }, { referencesProvider: true }),
    );
    const result = await session.references({
      language: 'typescript',
      path: 'src/shapes.ts',
      line: 6,
      column: 14,
      kind: 'constructor',
    });
    expect(paths(result)).toEqual(['src/shapes.ts:13:17']);
    await session.close();
  });
});

describe('overrides', () => {
  // Square.area overrides Shape.area. tsserver-style answers: the override family.
  const withoutTypes = {
    language: 'typescript',
    path: 'src/shapes.ts',
    line: 7,
    column: 12,
    kind: 'method' as const,
    baseMethods: [{ path: 'src/shapes.ts', line: 2, column: 3 }],
  };
  const squareArea = { ...withoutTypes, receiverTypes: ['Square', 'Shape'] };
  const types: Record<string, string> = { s: 'Shape', q: 'Square', c: 'Circle' };
  const fileLines = FILES['src/shapes.ts']!.split('\n');

  function server(): FakeServer {
    return new FakeServer({
      'textDocument/references': (params) => {
        const line = (params.position as { line: number }).line;
        // Square.area: only the call with a Square receiver. Shape.area: everything else.
        return line === 6
          ? [loc('src/shapes.ts', 'area', 4)]
          : [
              loc('src/shapes.ts', 'area', 1), // Square's declaration
              loc('src/shapes.ts', 'area', 2), // super.area()
              loc('src/shapes.ts', 'area', 3), // s.area()
              loc('src/shapes.ts', 'area', 5), // c.area()
              loc('src/shapes.ts', 'area', 6), // sq[0].area()
            ];
      },
      'textDocument/prepareCallHierarchy': () => [],
      'textDocument/typeDefinition': (params) => {
        const { line, character } = params.position as { line: number; character: number };
        const name = fileLines[line]!.slice(character).match(/^\w+/)![0];
        const decl = types[name]!;
        return [loc('src/shapes.ts', decl === 'Circle' ? 'Circle' : decl, 0)];
      },
    });
  }

  it('adds base-method calls whose receiver can reach the override and drops the rest', async () => {
    const { session } = await start(server);
    const result = await session.references(squareArea);
    if (result.status !== 'ok') throw new Error(result.reason);
    expect(result.references.map((r) => [r.range.startLine, r.range.startColumn, r.via])).toEqual([
      [14, 23, 'direct'], // q.area()
      [14, 12, 'base-method'], // s.area(), s: Shape
    ]);
    // c.area() (Circle), super.area() and the declaration are dropped; sq[0] is undecidable.
    expect(result.unresolved.map((r) => [r.range.startLine, r.range.startColumn])).toEqual([
      [14, 49],
    ]);
    expect(session.capabilities()[0]!.capabilitiesAttempted).toContain('typeDefinition');
    await session.close();
  });

  it('returns base-method calls as unresolved without receiver types', async () => {
    const { session } = await start(server);
    const result = await session.references(withoutTypes);
    if (result.status !== 'ok') throw new Error(result.reason);
    expect(result.references.map((r) => r.via)).toEqual(['direct']);
    expect(result.unresolved).toHaveLength(3); // s.area(), c.area(), sq[0].area()
    await session.close();
  });
});

describe('sibling receivers (#80)', () => {
  const lines = FILES['src/gateways.ts']!.split('\n');
  const types: Record<string, string[]> = {
    p: ['Paypal'],
    k: ['Connect'],
    a: ['Adyen'],
    r: ['Root'],
    i: ['Refunder'],
    u: ['Paypal', 'Adyen'],
    e: ['Express'],
  };
  /** Which `refund` a call resolves to statically, by its receiver: [line, character]. */
  const resolves: Record<string, [number, number]> = {
    p: [11, 2],
    k: [8, 11], // Connect inherits Stripe's
    a: [11, 2],
    r: [4, 2],
    i: [1, 2],
    u: [11, 2],
    e: [21, 11],
  };
  // Stripe.refund, and Stripe's name.
  const stripeRefund = {
    language: 'typescript',
    path: 'src/gateways.ts',
    line: 9,
    column: 12,
    kind: 'method' as const,
    receiverTypes: ['Stripe', 'Mid', 'Gateway'],
    ownerClass: { path: 'src/gateways.ts', line: 8, column: 14 },
  };
  /** Where a type's name is declared. */
  function declaration(name: string): Location {
    const line = lines.findIndex((l) => new RegExp(`(class|interface) ${name}\\b`).test(l));
    const character = lines[line]!.indexOf(` ${name}`) + 1;
    return {
      uri: uri('src/gateways.ts'),
      range: { start: { line, character }, end: { line, character: character + name.length } },
    };
  }
  const word = (params: Record<string, unknown>) => {
    const { line, character } = params.position as { line: number; character: number };
    return lines[line]!.slice(character).match(/^\w+/)![0];
  };
  /** A base's declaration, or for a call the `refund` it resolves to. */
  const definition = (params: Record<string, unknown>): Location => {
    if (word(params) !== 'refund') return declaration(word(params));
    const { line, character } = params.position as { line: number; character: number };
    const [l, c] = resolves[lines[line]![character - 2]!]!;
    const range = { start: { line: l, character: c }, end: { line: l, character: c + 6 } };
    return { uri: uri('src/gateways.ts'), range };
  };

  it('reports dropped calls with their receiver type, and which are siblings', async () => {
    const { session } = await start(
      () =>
        new FakeServer(
          {
            // Every declaration (0 to 3, 10), dropped, and every call.
            'textDocument/references': () =>
              [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) =>
                loc('src/gateways.ts', 'refund', n),
              ),
            'textDocument/prepareCallHierarchy': () => [],
            'textDocument/typeDefinition': (params) => types[word(params)]!.map(declaration),
            'textDocument/definition': (params) => [definition(params)],
          },
          { ...CAPABILITIES, definitionProvider: true },
        ),
    );
    const result = await session.references(stripeRefund);
    if (result.status !== 'ok') throw new Error(result.reason);
    // Connect is a subclass that inherits Stripe.refund, so `definition` lands on it.
    expect(result.references.map((r) => r.range.startColumn)).toEqual([17]);
    expect(result.excluded.map((e) => [e.range.startColumn, e.receiverType, e.sibling])).toEqual([
      [5, 'Paypal', true],
      [29, 'Adyen', true], // through Paypal
      [41, 'Root', false], // an ancestor of Stripe through Mid
      [53, 'Refunder', false], // an interface Stripe could satisfy
      [65, 'Paypal | Adyen', false],
      [5, 'Express', false], // a subclass that overrides it
    ]);
    // Without the class's position, its ancestors are not followed, so nothing is a sibling.
    const { ownerClass, ...withoutOwner } = stripeRefund;
    expect(ownerClass).toBeDefined();
    const unsettled = await session.references(withoutOwner);
    if (unsettled.status !== 'ok') throw new Error(unsettled.reason);
    expect(unsettled.excluded.filter((e) => e.sibling)).toEqual([]);
    expect(session.capabilities()[0]!.capabilitiesAttempted).toContain('definition');
    await session.close();
  });

  it('calls nothing a sibling when a base cannot be followed', async () => {
    const { session } = await start(
      () =>
        new FakeServer(
          {
            'textDocument/references': () => [loc('src/gateways.ts', 'refund', 4)],
            'textDocument/prepareCallHierarchy': () => [],
            'textDocument/typeDefinition': (params) => types[word(params)]!.map(declaration),
            'textDocument/definition': () => null,
          },
          { ...CAPABILITIES, definitionProvider: true },
        ),
    );
    const result = await session.references(stripeRefund);
    if (result.status !== 'ok') throw new Error(result.reason);
    expect(result.excluded.map((e) => [e.receiverType, e.sibling])).toEqual([['Paypal', false]]);
    await session.close();
  });
});

describe('capabilities and failures', () => {
  it('records unsupported methods and still answers', async () => {
    const { session } = await start(
      () =>
        new FakeServer(
          { 'textDocument/references': () => [loc('src/checkout.ts', 'formatPrice', 1)] },
          { referencesProvider: true },
        ),
    );
    await session.references(formatPrice);
    expect(session.capabilities()).toEqual([
      {
        language: 'typescript',
        server: { name: 'fake-ls', version: '1.0', configuration: 'user-configured command' },
        status: 'ok',
        capabilitiesAttempted: ['callHierarchy', 'references'],
        failures: [
          {
            capability: 'callHierarchy',
            message: 'fake-ls does not support textDocument/prepareCallHierarchy',
          },
        ],
        guidance: null,
      },
    ]);
    await session.close();
  });

  it('reports a server without references as unknown, not empty', async () => {
    const { session } = await start(() => new FakeServer({}, {}));
    expect(await session.references(formatPrice)).toMatchObject({ status: 'unknown' });
    expect(session.capabilities()[0]!.failures[0]!.capability).toBe('references');
    await session.close();
  });

  it('restarts a crashed server once, then reports it failed', async () => {
    const call = loc('src/checkout.ts', 'formatPrice', 1);
    let instance = 0;
    const flaky = await start(() => {
      const crashes = instance++ === 0;
      return new FakeServer(
        { 'textDocument/references': (_, s) => (crashes ? s.crash() : [call]) },
        { referencesProvider: true },
      );
    });
    expect(paths(await flaky.session.references(formatPrice))).toEqual(['src/checkout.ts:4:10']);
    expect(flaky.servers).toHaveLength(2);
    expect(flaky.session.capabilities()[0]!.status).toBe('ok');
    await flaky.session.close();

    const broken = await start(
      () =>
        new FakeServer(
          { 'textDocument/references': (_, s) => s.crash() },
          { referencesProvider: true },
        ),
    );
    expect(await broken.session.references(formatPrice)).toMatchObject({ status: 'unknown' });
    const [cap] = broken.session.capabilities();
    expect(cap!.status).toBe('failed');
    expect(cap!.guidance).toMatch(/fake-ls exited/);
    await broken.session.close();
  });

  it('reports a server that fails to initialise as failed', async () => {
    const { session } = await start(
      () =>
        new FakeServer({
          initialize: () => {
            throw new Error('no tsserver.js');
          },
        }),
    );
    expect(session.capabilities()[0]).toMatchObject({
      status: 'failed',
      server: null,
      guidance: expect.stringMatching(/fake-ls failed to start: .*no tsserver\.js/) as unknown,
    });
    expect(await session.references(formatPrice)).toMatchObject({ status: 'unknown' });
  });

  it('needs an opt-in before starting a server that runs project code', async () => {
    const { session, servers } = await start(() => new FakeServer({}), {}, ['java']);
    expect(servers).toHaveLength(0);
    expect(session.capabilities()[0]).toMatchObject({
      language: 'java',
      status: 'needs-opt-in',
      server: null,
      guidance: expect.stringMatching(
        /^Java callers: possible only — jdtls imports Maven/,
      ) as unknown,
    });
  });

  it('reports missing, disabled and unsupported languages without starting anything', async () => {
    const missing = await LspSession.start(root, ['python', 'cobol'], { searchPath: '' });
    expect(missing.capabilities().map((c) => [c.language, c.status, c.guidance])).toEqual([
      [
        'python',
        'not-installed',
        'Python callers: possible only — pyright not found; install pyright (`npm i -g pyright`) to verify',
      ],
      ['cobol', 'not-installed', 'cobol callers: possible only — no supported language server'],
    ]);
    const off = await LspSession.start(root, ['typescript'], { enabled: false });
    expect(off.capabilities()[0]!.status).toBe('disabled');
  });
});

describe('project health', () => {
  const unresolved = {
    range: { start: { line: 0, character: 18 }, end: { line: 0, character: 35 } },
    message: "Cannot find module 'missing-package' or its corresponding type declarations.",
    code: 2307,
  };

  it('uses pushed diagnostics and marks the language unhealthy', async () => {
    const { session } = await start(
      () =>
        new FakeServer({
          'textDocument/didOpen': (params, server) => {
            const doc = params.textDocument as { uri: string };
            const diagnostics = doc.uri.endsWith('broken.ts') ? [unresolved] : [];
            server.notify('textDocument/publishDiagnostics', { uri: doc.uri, diagnostics });
          },
        }),
    );
    expect(await session.projectHealth('typescript', ['src/checkout.ts'])).toEqual({
      healthy: true,
      imports: 1,
      unresolved: [],
      reason: null,
    });
    const health = await session.projectHealth('typescript', ['src/checkout.ts', 'src/broken.ts']);
    expect(health).toMatchObject({ healthy: false, imports: 3 });
    expect(health.unresolved).toEqual([
      { path: 'src/broken.ts', line: 1, message: unresolved.message },
    ]);
    const [cap] = session.capabilities();
    expect(cap!.status).toBe('unhealthy');
    expect(cap!.guidance).toMatch(/1 of 3 imports .* do not resolve.*npm ci/);
    // A later check of files that resolve does not hide it.
    expect(await session.projectHealth('typescript', ['src/checkout.ts'])).toMatchObject({
      healthy: true,
    });
    expect(session.capabilities()[0]!.status).toBe('unhealthy');
    await session.close();
  });

  it('uses pulled diagnostics when the server offers them', async () => {
    const { session } = await start(
      () =>
        new FakeServer(
          { 'textDocument/diagnostic': () => ({ kind: 'full', items: [unresolved] }) },
          { referencesProvider: true, diagnosticProvider: {} },
        ),
      { maxUnresolvedImportShare: 0.5 },
    );
    const health = await session.projectHealth('typescript', ['src/broken.ts']);
    expect(health).toMatchObject({ healthy: true, imports: 2 });
    expect(health.unresolved).toHaveLength(1);
    await session.close();
  });

  it('is not healthy when the server publishes no diagnostics', async () => {
    const { session } = await start(() => new FakeServer({}));
    const health = await session.projectHealth('typescript', ['src/checkout.ts']);
    expect(health).toMatchObject({ healthy: false, reason: /no diagnostics/ });
    await session.close();
  });
});
