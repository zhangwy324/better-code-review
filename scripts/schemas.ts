// Writes the JSON Schema files for the data contracts (src/schemas/json-schema.ts) to schemas/.
// Usage: node scripts/schemas.ts
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonSchemas } from '../src/schemas/json-schema.ts';

const outDir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'schemas');
mkdirSync(outDir, { recursive: true });
for (const file of readdirSync(outDir)) rmSync(join(outDir, file));

const schemas = jsonSchemas();
for (const [file, schema] of Object.entries(schemas)) {
  writeFileSync(join(outDir, file), `${JSON.stringify(schema, null, 2)}\n`);
}
console.log(`Wrote ${Object.keys(schemas).length} JSON Schema files to ${outDir}`);
