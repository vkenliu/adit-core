/**
 * Project Link — public API for connecting a local codebase to adit-cloud.
 *
 * Exports command handlers, utility functions, and type definitions
 * for the `/adit link` and `/adit intent` plugin commands.
 */

// Command handlers
export { linkCommand } from "./link-command.js";
export { intentCommand, formatIntentList, formatIntentDetail } from "./intent-command.js";

// Auto-sync
export { triggerProjectLinkSync } from "./auto-link.js";

// Quality check
export { checkQuality, formatQualityFeedback } from "./qualify.js";

// Git collection
export {
  collectRemoteUrl,
  collectDefaultBranch,
  collectCurrentBranch,
  collectBranches,
  collectCommitLogs,
  collectCommitCount,
  resolveCommitBranches,
  projectNameFromRemoteUrl,
} from "./git-collector.js";

// Document discovery
export { discoverDocuments, loadDocSettings } from "./doc-discovery.js";

// Local cache
export {
  getProjectLinkCache,
  upsertProjectLinkCache,
  clearProjectLinkCache,
  updateCachedCommitSha,
  updateCachedDocHashes,
  updateCachedQualified,
} from "./cache.js";

// Types
export type {
  GitBranch,
  GitCommit,
  DiscoveredDocument,
  ProjectLinkCache,
  NegotiateResponse,
  LinkInitResponse,
  CommitUploadResponse,
  DocumentUploadResponse,
  QualifyResponse,
  LinkStatusResponse,
  IntentSummary,
  IntentDetail,
  TaskSlice,
  StepTiming,
  LinkOptions,
  IntentOptions,
  LinkResult,
  IntentResult,
} from "./types.js";
