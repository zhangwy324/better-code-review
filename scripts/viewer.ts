// Serves the viewer (src/viewer) with a review's data, for development. The directory is one that
// `generate` wrote: it must hold changes.json, graph.json and plan.json.
// Usage: npm run viewer -- <review-dir> (src/viewer/README.md shows one for a fixture)
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { dataScripts } from '../src/viewer/embed.ts';

const [dir] = process.argv.slice(2);
if (dir === undefined) {
  console.error('Usage: npm run viewer -- <review-dir>');
  process.exit(2);
}

const read = (file: string): unknown => JSON.parse(readFileSync(join(dir, file), 'utf8'));
const documents = {
  changes: read('changes.json'),
  graph: read('graph.json'),
  plan: read('plan.json'),
};

const server = await createServer({
  plugins: [
    {
      name: 'better-code-review-data',
      transformIndexHtml: (html) => html.replace('</body>', `${dataScripts(documents)}\n</body>`),
    },
  ],
});
await server.listen();
console.log(`Serving ${resolve(dir)}`);
server.printUrls();
