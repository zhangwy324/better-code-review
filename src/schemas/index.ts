// The versioned data contracts shared by every stage. See README.md in this folder.
import type { z } from 'zod';
import { CHANGESET_SCHEMA_VERSION, ChangeSet } from './changeset.ts';
import { FEEDBACK_SCHEMA_VERSION, ReviewFeedback } from './feedback.ts';
import { GRAPH_SCHEMA_VERSION, ChangeGraph } from './graph.ts';
import { PLAN_SCHEMA_VERSION, ReviewPlan } from './plan.ts';
import { SEMANTIC_SCHEMA_VERSION, SemanticEvidence } from './semantic.ts';
import { STRUCTURAL_SCHEMA_VERSION, StructuralChangeSet } from './structural.ts';

export * from './common.ts';
export * from './ids.ts';
export * from './request.ts';
export * from './changeset.ts';
export * from './structural.ts';
export * from './semantic.ts';
export * from './graph.ts';
export * from './plan.ts';
export * from './feedback.ts';

/** Every versioned document, keyed by the name its JSON Schema file is published under. */
export const CONTRACTS = {
  'change-set': { schema: ChangeSet, version: CHANGESET_SCHEMA_VERSION },
  'structural-change-set': { schema: StructuralChangeSet, version: STRUCTURAL_SCHEMA_VERSION },
  'semantic-evidence': { schema: SemanticEvidence, version: SEMANTIC_SCHEMA_VERSION },
  'change-graph': { schema: ChangeGraph, version: GRAPH_SCHEMA_VERSION },
  'review-plan': { schema: ReviewPlan, version: PLAN_SCHEMA_VERSION },
  'review-feedback': { schema: ReviewFeedback, version: FEEDBACK_SCHEMA_VERSION },
} as const;

export type ContractName = keyof typeof CONTRACTS;
export type Contract<N extends ContractName> = z.infer<(typeof CONTRACTS)[N]['schema']>;

export class SchemaVersionError extends Error {
  readonly contract: ContractName;
  readonly found: unknown;
  readonly supported: number;

  constructor(contract: ContractName, found: unknown, supported: number) {
    super(
      typeof found === 'number' && found > supported
        ? `${contract} has schemaVersion ${found}, but this build reads ${supported}: it was written by a newer better-code-review`
        : `${contract} has schemaVersion ${String(found)}, but this build reads ${supported}`,
    );
    this.name = 'SchemaVersionError';
    this.contract = contract;
    this.found = found;
    this.supported = supported;
  }
}

/**
 * Parses a document, checking `schemaVersion` first so that a version mismatch is reported as
 * such rather than as a list of field errors. Older versions are migrated here, once a contract
 * has any (README.md, "Versioning"). Throws `SchemaVersionError` or `z.ZodError`.
 */
export function parseContract<N extends ContractName>(name: N, data: unknown): Contract<N> {
  const { schema, version } = CONTRACTS[name];
  const found = (data as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (found !== version) throw new SchemaVersionError(name, found, version);
  return schema.parse(data) as Contract<N>;
}
