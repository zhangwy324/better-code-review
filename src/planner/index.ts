// The planner's model input (#22): planner-input.md, on-demand context and secret avoidance; the
// validator for the plan it writes (#23); the deterministic fallback plan (#24); and the caller
// candidates the agent judges (#43).
export {
  CANDIDATES_DIR,
  candidateBatches,
  edgeStatuses,
  MAX_ADJUDICATED_EDGES,
  MAX_GROUPS_PER_BATCH,
  selectCandidates,
  type CandidateBatch,
  type CandidateOptions,
  type Candidates,
  type CandidateSelection,
  type EdgeStatus,
} from './candidates.ts';
export { fallbackPlan, NO_AGENT_REASON } from './fallback.ts';
export {
  DEFAULT_MAX_HUNK_LINES,
  DEFAULT_TOKEN_BUDGET,
  estimateTokens,
  plannerInput,
  type PlannerInput,
  type PlannerInputOptions,
} from './input.ts';
export { redactSecrets, sensitiveFile } from './secrets.ts';
export { MAX_SHOW_LINES, show, ShowError, type ShowQuery } from './show.ts';
export {
  validatePlan,
  type PlanError,
  type PlanErrorCode,
  type PlanValidation,
} from './validate.ts';
