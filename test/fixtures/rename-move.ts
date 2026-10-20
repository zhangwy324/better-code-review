// Renames and moves. `slugify` is renamed to `toSlug` and its file moves from src/utils/ to
// src/text/, with its caller updated; src/utils/clamp.ts moves unchanged to src/math/, so only
// the import in src/layout.ts changes.
import { type Files, type Fixture, lines, TSCONFIG } from './fixture.ts';

const titleCase = [
  '',
  'export function titleCase(title: string): string {',
  '  return title.replace(/\\b\\w/g, (c) => c.toUpperCase());',
  '}',
];

const clamp = lines(
  'export function clamp(value: number, min: number, max: number): number {',
  '  return Math.min(Math.max(value, min), max);',
  '}',
);

const base: Files = {
  'tsconfig.json': TSCONFIG,
  'src/utils/slug.ts': lines(
    'export function slugify(title: string): string {',
    "  return title.trim().toLowerCase().replace(/\\s+/g, '-');",
    '}',
    ...titleCase,
  ),
  'src/urls.ts': lines(
    "import { slugify } from './utils/slug.ts';",
    '',
    'export function postUrl(title: string): string {',
    '  return `/posts/${slugify(title)}`;',
    '}',
  ),
  'src/utils/clamp.ts': clamp,
  'src/layout.ts': lines(
    "import { clamp } from './utils/clamp.ts';",
    '',
    'export function fit(width: number): number {',
    '  return clamp(width, 320, 1280);',
    '}',
  ),
};

const head: Files = {
  'src/utils/slug.ts': null,
  'src/text/slug.ts': lines(
    'export function toSlug(title: string): string {',
    "  return title.trim().toLowerCase().replace(/\\s+/g, '-');",
    '}',
    ...titleCase,
  ),
  'src/urls.ts': lines(
    "import { toSlug } from './text/slug.ts';",
    '',
    'export function postUrl(title: string): string {',
    '  return `/posts/${toSlug(title)}`;',
    '}',
  ),
  'src/utils/clamp.ts': null,
  'src/math/clamp.ts': clamp,
  'src/layout.ts': lines(
    "import { clamp } from './math/clamp.ts';",
    '',
    'export function fit(width: number): number {',
    '  return clamp(width, 320, 1280);',
    '}',
  ),
};

export const renameMove: Fixture = {
  name: 'rename-move',
  summary: 'A renamed function in a moved file, and a file moved without changes.',
  base,
  head,
  expected: {
    files: [
      'src/text/slug.ts structural',
      'src/urls.ts structural',
      'src/math/clamp.ts structural',
      'src/layout.ts structural',
    ],
    // The pure move has no hunks, so its file node has none either.
    nodes: [
      'symbol toSlug',
      'module src/urls.ts',
      'symbol postUrl',
      'file src/math/clamp.ts',
      'module src/layout.ts',
    ],
    // The old side calls slugify, the new side toSlug: one edge, on both sides.
    edges: ['postUrl calls toSlug (both)'],
  },
  later: ['M3: the toSlug node shows its old name and path.'],
};
