// ReviewPlan (§9.6): interpretation layered over the graph, written as plan.json. Written by the
// agent through the skill (#25), or by the deterministic fallback planner (#24), and checked by
// the plan validator (#23).
//
// Invariants (spec D1, D2, D5, D6, D8):
// - Every node has exactly one home group: it is in one group's `nodeIds`, or the validator puts
//   it in the reserved `ungrouped` group. Other groups may list it in `referenceNodeIds`.
// - Every node, edge and group ID referenced exists (spec invariant 3).
// - Verdicts label existing `possible` code edges; the plan never adds code edges or code text.
//   Nothing here is ever shown as `verified`.
// - Plan text is untrusted and rendered inert (spec invariant 6).
import { z } from 'zod';
import { EdgeId, LineRef, LocalId, NodeId, SnapshotId } from './common.ts';

export const PLAN_SCHEMA_VERSION = 1;

/** The group that holds every node without a home (D1). */
export const UNGROUPED_GROUP_ID = 'ungrouped';

export const ReviewGroup = z.strictObject({
  id: LocalId,
  title: z.string().min(1),
  description: z.string(),
  /** Nodes whose home is this group. */
  nodeIds: z.array(NodeId),
  /** Nodes homed elsewhere and shown here as references (link chips, D2). */
  referenceNodeIds: z.array(NodeId),
  /** Nested groups, one level deep in v0.1 (D2). */
  childGroupIds: z.array(LocalId),
});

/** The agent's verdict on a `possible` code edge (D6, #43). The edge stays `possible`. */
export const EdgeVerdict = z.strictObject({
  edgeId: EdgeId,
  /** `unsure` leaves the edge as plain `possible` (#42). `no` keeps it visible as rejected. */
  verdict: z.enum(['yes', 'no', 'unsure']),
  /** How the call reaches the target, when the verdict is `yes`. */
  via: z.enum(['direct', 'dispatch', 'alias']).nullable(),
  reason: z.string().min(1),
  citedLine: LineRef,
});

export const InferredRelationship = z.strictObject({
  id: LocalId,
  from: NodeId,
  to: NodeId,
  kind: z.enum(['change-propagation', 'architectural', 'logically-related']),
  explanation: z.string().min(1),
  /** Lines that support the claim. They must exist in the snapshot. */
  citedLines: z.array(LineRef),
});

export const ReviewPlan = z.strictObject({
  schemaVersion: z.literal(PLAN_SCHEMA_VERSION),
  snapshotId: SnapshotId,
  /** Who wrote the plan. `fallback` is also used when the agent's plan failed validation (D8). */
  origin: z.enum(['agent', 'fallback']),
  /** Why the fallback plan was used, shown in the artifact; null for agent plans. */
  fallbackReason: z.string().nullable(),
  summary: z.string(),
  groups: z.array(ReviewGroup),
  /** Reading order of the top-level groups (MVP has no reading-order edges, D6). */
  groupOrder: z.array(LocalId),
  edgeVerdicts: z.array(EdgeVerdict),
  inferredRelationships: z.array(InferredRelationship),
});

export type ReviewGroup = z.infer<typeof ReviewGroup>;
export type EdgeVerdict = z.infer<typeof EdgeVerdict>;
export type InferredRelationship = z.infer<typeof InferredRelationship>;
export type ReviewPlan = z.infer<typeof ReviewPlan>;
