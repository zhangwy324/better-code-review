// The semantic analyzer: caller candidates between changed entities (#17) and the optional LSP
// tier (#16). See README.md in this folder.
export {
  analyzeSemantics,
  MAX_CANDIDATES_PER_ENTITY,
  MAX_DEFINITION_FILES,
  type ReferenceProvider,
  type SemanticOptions,
} from './analyze.ts';
export { findHits, type Hit } from './hits.ts';
export { MAX_REEXPORT_DEPTH } from './imports.ts';
export { linkInstalledModules, type SnapshotModules, unlinkInstalledModules } from './modules.ts';
export { changeSetFiles, gitSnapshotFiles, type SnapshotFiles } from './snapshot-files.ts';
export {
  DEFAULT_TIMEOUTS,
  type FilePosition,
  type LspOptions,
  LspSession,
  type LspTimeouts,
  type ProjectHealth,
  type ReferenceSite,
  type ReferencesResult,
  type ReferenceTarget,
} from './session.ts';
export { rangeContains } from './normalise.ts';
export { SERVERS, type ServerId, type ServerOverride } from './servers.ts';
