// TEMPORARY (#112 evidence): prints hashes of the built page and its notices. Removed before merge.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const page = readFileSync('dist/viewer/index.html', 'utf8');
const notices = /<!--\n(Better Code Review[\s\S]*?)\n-->/.exec(page)?.[1] ?? '';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
console.log(`page sha256 ${sha(page)} bytes ${Buffer.byteLength(page)}`);
console.log(
  `notices sha256 ${sha(notices)} bytes ${Buffer.byteLength(notices)} CR ${notices.includes('\r')}`,
);
console.log(`packages: ${[...notices.matchAll(/^## (.+)$/gm)].map((m) => m[1]).join(', ')}`);
