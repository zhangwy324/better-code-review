// Files without built-in structure: a binary image, Ruby, Go and Markdown, next to one
// TypeScript change. Each gets a file node, so every hunk is still reachable (invariant 7).
import { type Files, type Fixture, lines, TSCONFIG } from './fixture.ts';

/** A PNG signature followed by bytes that include NUL, so Git treats it as binary. */
const png = (seed: number) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(Array.from({ length: 256 }, (_, i) => (i * seed) % 256)),
  ]);

const base: Files = {
  'tsconfig.json': TSCONFIG,
  'assets/logo.png': png(7),
  'scripts/deploy.rb': lines('def deploy(env)', '  puts "deploying to #{env}"', 'end'),
  'cmd/server/main.go': lines(
    'package main',
    '',
    'import "fmt"',
    '',
    'func main() {',
    '\tfmt.Println("listening on :8080")',
    '}',
  ),
  'docs/guide.md': lines('# Guide', '', 'Run `npm start`.'),
  'src/banner.ts': lines('export function banner(): string {', "  return 'Shop';", '}'),
};

const head: Files = {
  'assets/logo.png': png(11),
  'scripts/deploy.rb': lines(
    'def deploy(env, dry_run: false)',
    '  puts "deploying to #{env}#{dry_run ? " (dry run)" : ""}"',
    'end',
  ),
  'cmd/server/main.go': lines(
    'package main',
    '',
    'import "fmt"',
    '',
    'func main() {',
    '\tfmt.Println("listening on :9090")',
    '}',
  ),
  'docs/guide.md': lines('# Guide', '', 'Run `npm start`, then open http://localhost:9090.'),
  'src/banner.ts': lines(
    'export function banner(): string {',
    "  return 'Shop · now on port 9090';",
    '}',
  ),
};

export const unsupportedBinary: Fixture = {
  name: 'unsupported-binary',
  summary: 'A binary file and files in languages without built-in structure.',
  base,
  head,
  expected: {
    files: [
      'assets/logo.png git-only binary',
      'scripts/deploy.rb git-only',
      'cmd/server/main.go git-only',
      'docs/guide.md git-only',
      'src/banner.ts structural',
    ],
    nodes: [
      'file assets/logo.png',
      'file scripts/deploy.rb',
      'file cmd/server/main.go',
      'file docs/guide.md',
      'symbol banner',
    ],
    edges: [],
  },
  // The port moving to 9090 (server, guide and banner) is one change; the deploy script's dry
  // run is another. The logo is left out: it may sit with either, or with the other files.
  plan: {
    apart: [['cmd/server/main.go', 'docs/guide.md', 'banner'], ['scripts/deploy.rb']],
  },
  later: [
    'M1: the language report lists TypeScript only; Ruby and Go are not built in (#45).',
    'M3: the binary file is listed with no diff text, and each file node opens its hunks.',
  ],
};
