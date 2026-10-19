// SemanticEvidence (§9.4): relationships between changed entities (D12), with how each was found.
// Produced by the semantic analyzer (#16, #17). The graph copies the records its edges cite.
//
// Invariants:
// - Both ends of every record are changed entities (D12).
// - Only `lsp` records can be `confirmed` into a `verified` edge (spec invariant 4).
// - "Not found" is not "unavailable": a server that failed or was not ready is reported in
//   `languages`, and an empty answer from it is not a rejection (ADR 0001).
import { z } from 'zod';
import { CodeLocation, EntityId, EvidenceId, SnapshotId } from './common.ts';

export const SEMANTIC_SCHEMA_VERSION = 1;

export const CodeRelation = z.enum(['calls', 'references', 'implements']);

export const LspCapability = z.enum(['definition', 'references', 'callHierarchy', 'implementation']);

/** Per-language semantic capability, shown in the artifact (D11). */
export const LanguageCapability = z.strictObject({
  language: z.string().min(1),
  /** The language server used, or null when none was. */
  server: z.strictObject({ name: z.string().min(1), version: z.string().nullable() }).nullable(),
  status: z.enum([
    /** The server answered. */
    'ok',
    /** No server is installed (D11: never installed for the user). */
    'not-installed',
    /** LSP was turned off for this run. */
    'disabled',
    /** The server would run project code and the user has not opted in (D11). */
    'needs-opt-in',
    /** The server never became ready. */
    'not-ready',
    /** The server crashed or returned errors. */
    'failed',
  ]),
  capabilitiesAttempted: z.array(LspCapability),
  failures: z.array(z.strictObject({ capability: LspCapability, message: z.string() })),
  /** What the reviewer can do about a missing capability, e.g. "install pyright to verify". */
  guidance: z.string().nullable(),
});

export const EvidenceRecord = z.strictObject({
  id: EvidenceId,
  relation: CodeRelation,
  /** The entity containing the hit, e.g. the caller. */
  sourceEntityId: EntityId,
  /** The changed entity the hit refers to, e.g. the callee. */
  targetEntityId: EntityId,
  /** Where the hit is. */
  location: CodeLocation,
  method: z.enum(['text-search', 'import-resolution', 'lsp']),
  /** `candidate` for text search; `confirmed` or `rejected` for the methods that decide. */
  outcome: z.enum(['candidate', 'confirmed', 'rejected']),
  /** Free-form provider detail, e.g. the LSP request used. */
  detail: z.string().nullable(),
});

/** A fan-out cap applied to one entity: the artifact says "Showing N of M" (D1). */
export const FanOutCap = z
  .strictObject({
    entityId: EntityId,
    relation: CodeRelation,
    shown: z.int().min(0),
    total: z.int().min(0),
  })
  .refine((c) => c.shown <= c.total, { message: 'shown must be <= total' });

export const SemanticEvidence = z.strictObject({
  schemaVersion: z.literal(SEMANTIC_SCHEMA_VERSION),
  snapshotId: SnapshotId,
  languages: z.array(LanguageCapability),
  records: z.array(EvidenceRecord),
  caps: z.array(FanOutCap),
});

export type CodeRelation = z.infer<typeof CodeRelation>;
export type LanguageCapability = z.infer<typeof LanguageCapability>;
export type EvidenceRecord = z.infer<typeof EvidenceRecord>;
export type FanOutCap = z.infer<typeof FanOutCap>;
export type SemanticEvidence = z.infer<typeof SemanticEvidence>;
