// Dynamic calls that defeat static analysis: `resizeImage` changes, and the changed `dispatch`
// and `runByName` reach it only through a computed property and `Reflect.apply`, with its name
// only in a string. Nothing in the graph relates them.
import { type Files, type Fixture, lines, TSCONFIG } from './fixture.ts';

const dispatch = (suffix: string) =>
  lines(
    "import * as handlers from './handlers.ts';",
    '',
    'type Handler = (width: number) => string;',
    'const table = handlers as Record<string, Handler>;',
    '',
    'export function dispatch(action: string, width: number): string {',
    `  return table[\`\${action}${suffix}\`]!(width);`,
    '}',
  );

const base: Files = {
  'tsconfig.json': TSCONFIG,
  'src/handlers.ts': lines(
    'export function resizeImage(width: number): string {',
    '  return `resize ${width}`;',
    '}',
  ),
  'src/dispatch.ts': dispatch(''),
  'src/plugins.ts': lines(
    "import * as handlers from './handlers.ts';",
    '',
    'export function runByName(name: string, width: number): unknown {',
    '  const fn = (handlers as Record<string, unknown>)[name] as (w: number) => string;',
    '  return Reflect.apply(fn, undefined, [width]);',
    '}',
  ),
};

const head: Files = {
  'src/handlers.ts': lines(
    'export function resizeImage(width: number, height = width): string {',
    '  return `resize ${width}x${height}`;',
    '}',
  ),
  'src/dispatch.ts': dispatch('Image'),
  'src/plugins.ts': lines(
    "import * as handlers from './handlers.ts';",
    '',
    'export function runByName(name: string, width: number): unknown {',
    "  if (name === 'resizeImage') console.log('resizing');",
    '  const fn = (handlers as Record<string, unknown>)[name] as (w: number) => string;',
    '  return Reflect.apply(fn, undefined, [width]);',
    '}',
  ),
};

export const dynamicCalls: Fixture = {
  name: 'dynamic-calls',
  summary: 'A changed function reached only through computed property access and reflection.',
  base,
  head,
  expected: {
    files: [
      'src/handlers.ts structural',
      'src/dispatch.ts structural',
      'src/plugins.ts structural',
    ],
    nodes: ['symbol resizeImage', 'symbol dispatch', 'symbol runByName'],
    // The computed call and Reflect.apply name no symbol, and the string is skipped: a known gap
    // of static analysis, shown as unrelated roots.
    edges: [],
  },
  // A language server cannot see through the computed access either, so there are no edges.
  later: ['M2: an agent may link them as an inferred relationship, never as a code edge (D6).'],
};
