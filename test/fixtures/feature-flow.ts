// A new feature across layers: a route handler, a service, a repository and a test, wired into
// the existing router.
import { type Files, type Fixture, lines, TSCONFIG } from './fixture.ts';

const base: Files = {
  'tsconfig.json': TSCONFIG,
  'src/http.ts': lines(
    'export type Handler = (body: unknown) => unknown;',
    '',
    'export interface Router {',
    '  get(path: string, handler: Handler): void;',
    '  post(path: string, handler: Handler): void;',
    '}',
  ),
  'src/routes/health.ts': lines(
    'export function getHealth(): unknown {',
    "  return { status: 'ok' };",
    '}',
  ),
  'src/app.ts': lines(
    "import type { Router } from './http.ts';",
    "import { getHealth } from './routes/health.ts';",
    '',
    'export function registerRoutes(router: Router): void {',
    "  router.get('/health', getHealth);",
    '}',
  ),
};

const head: Files = {
  'src/app.ts': lines(
    "import type { Router } from './http.ts';",
    "import { getHealth } from './routes/health.ts';",
    "import { postOrder } from './routes/orders.ts';",
    '',
    'export function registerRoutes(router: Router): void {',
    "  router.get('/health', getHealth);",
    "  router.post('/orders', postOrder);",
    '}',
  ),
  'src/routes/orders.ts': lines(
    "import { createOrder } from '../services/orders.ts';",
    '',
    'export function postOrder(body: unknown): unknown {',
    '  const { sku, quantity } = body as { sku: string; quantity: number };',
    '  return createOrder(sku, quantity);',
    '}',
  ),
  'src/services/orders.ts': lines(
    "import { insertOrder, type OrderRow } from '../db/orders.ts';",
    '',
    'export function createOrder(sku: string, quantity: number): OrderRow {',
    "  if (quantity < 1) throw new Error('quantity must be positive');",
    '  return insertOrder(sku, quantity);',
    '}',
  ),
  'src/db/orders.ts': lines(
    'export interface OrderRow {',
    '  id: number;',
    '  sku: string;',
    '  quantity: number;',
    '}',
    '',
    'const rows: OrderRow[] = [];',
    '',
    'export function insertOrder(sku: string, quantity: number): OrderRow {',
    '  const row = { id: rows.length + 1, sku, quantity };',
    '  rows.push(row);',
    '  return row;',
    '}',
  ),
  'test/orders.test.ts': lines(
    "import { describe, expect, it } from 'vitest';",
    "import { createOrder } from '../src/services/orders.ts';",
    '',
    "describe('createOrder', () => {",
    "  it('assigns an id', () => {",
    "    expect(createOrder('book', 1).id).toBe(1);",
    '  });',
    '});',
  ),
};

export const featureFlow: Fixture = {
  name: 'feature-flow',
  summary: 'A new feature from route to service to persistence, with a test.',
  base,
  head,
  expected: {
    files: [
      'src/app.ts structural',
      'src/routes/orders.ts structural',
      'src/services/orders.ts structural',
      'src/db/orders.ts structural',
      'test/orders.test.ts structural test',
    ],
    // Import lines are module code, so every changed file has a module node. The describe block is
    // a test entity named by its title.
    nodes: [
      'module src/app.ts',
      'symbol registerRoutes',
      'module src/routes/orders.ts',
      'symbol postOrder',
      'module src/services/orders.ts',
      'symbol createOrder [src/services/orders.ts]',
      'module src/db/orders.ts',
      'symbol OrderRow',
      'symbol insertOrder',
      'module test/orders.test.ts',
      'symbol createOrder [test/orders.test.ts]',
      'symbol createOrder.assigns an id',
    ],
    // One edge per layer, plus the type references. The test's calls make one test-file edge.
    edges: [
      'registerRoutes references postOrder (new)',
      'postOrder calls createOrder [src/services/orders.ts] (new)',
      'createOrder [src/services/orders.ts] calls insertOrder (new)',
      'createOrder [src/services/orders.ts] references OrderRow (new)',
      'insertOrder references OrderRow (new)',
      'src/db/orders.ts references OrderRow (new)',
      'test/orders.test.ts calls createOrder [src/services/orders.ts] (new)',
    ],
  },
  later: ['M2: the plan reads the flow in order, route → service → persistence → test (#26).'],
};
