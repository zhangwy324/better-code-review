// JSON Schema export of the contracts for non-TypeScript consumers, such as the agent writing
// plan.json. Written to schemas/ by `npm run schemas`; a test fails when the files are stale.
import { z } from 'zod';
import { CONTRACTS, type ContractName } from './index.ts';

/** The JSON Schema for each contract, keyed by file name, e.g. `review-plan.schema.json`. */
export function jsonSchemas(): Record<`${ContractName}.schema.json`, object> {
  const entries = Object.entries(CONTRACTS).map(([name, { schema, version }]) => [
    `${name}.schema.json`,
    {
      ...z.toJSONSchema(schema, { target: 'draft-2020-12' }),
      title: `${name} v${version}`,
      $comment:
        'Generated from src/schemas by `npm run schemas`; do not edit. Refinements that JSON Schema cannot express (repository-relative paths, range order) are checked by the Zod schemas only.',
    },
  ]);
  return Object.fromEntries(entries) as Record<`${ContractName}.schema.json`, object>;
}
