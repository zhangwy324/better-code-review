// Three unrelated changes in one commit: a cart rounding fix, a logging default and a message
// text. Nothing relates them, so the graph has three roots and no edges.
import { type Files, type Fixture, lines, TSCONFIG } from './fixture.ts';

const base: Files = {
  'tsconfig.json': TSCONFIG,
  'src/cart.ts': lines(
    'export function cartTotal(prices: number[]): number {',
    '  return prices.reduce((sum, p) => sum + p, 0);',
    '}',
  ),
  'src/logger.ts': lines(
    'export function logLevel(env: Record<string, string | undefined>): string {',
    "  return env['LOG_LEVEL'] ?? 'debug';",
    '}',
  ),
  'src/i18n/messages.ts': lines(
    'export function welcomeMessage(name: string): string {',
    '  return `Welcome, ${name}`;',
    '}',
  ),
};

const head: Files = {
  'src/cart.ts': lines(
    'export function cartTotal(prices: number[]): number {',
    '  return Math.round(prices.reduce((sum, p) => sum + p, 0) * 100) / 100;',
    '}',
  ),
  'src/logger.ts': lines(
    'export function logLevel(env: Record<string, string | undefined>): string {',
    "  return env['LOG_LEVEL'] ?? 'info';",
    '}',
  ),
  'src/i18n/messages.ts': lines(
    'export function welcomeMessage(name: string): string {',
    '  return `Welcome back, ${name}!`;',
    '}',
  ),
};

export const independentRoots: Fixture = {
  name: 'independent-roots',
  summary: 'Three unrelated changes in one commit, with no relationships between them.',
  base,
  head,
  expected: {
    files: [
      'src/cart.ts structural',
      'src/logger.ts structural',
      'src/i18n/messages.ts structural',
    ],
    nodes: ['symbol cartTotal', 'symbol logLevel', 'symbol welcomeMessage'],
    edges: [],
  },
  later: ['M2: the plan puts the three changes in separate groups (#26).'],
};
