/**
 * @adit/core — Core types, database, config, and sync primitives.
 *
 * This is the foundation package. All other ADIT packages depend on it.
 */

// Types
export type {
  EventType,
  Actor,
  EventStatus,
  ErrorCategory,
  FileStat,
  EventError,
  AditEvent,
} from "./types/index.js";
export { parseLabels, parseDiffStats, parseError } from "./types/index.js";

export type {
  SessionStatus,
  Platform,
  SessionType,
  SessionMetadata,
  AditSession,
} from "./types/index.js";

export type {
  PlanType,
  PlanStatus,
  AditPlan,
} from "./types/index.js";

export type { EnvSnapshot, EnvDiff, EnvChange } from "./types/index.js";

// Database
export {
  openDatabase,
  closeDatabase,
  insertSession,
  getSessionById,
  getActiveSession,
  getSessionByPlatformSessionId,
  endSession,
  listSessions,
  insertEvent,
  insertEventAutoSeq,
  getEventById,
  queryEvents,
  getEventsBySession,
  updateEventStatus,
  updateEventCheckpoint,
  updateEventLabels,
  allocateSequence,
  searchEvents,
  getLatestCheckpointEvent,
  getLatestCheckpointByBranch,
  getRecentCheckpointsExcludingBranch,
  clearEvents,
  countEvents,
  insertDiff,
  getDiffByEventId,
  getDiffText,
  insertPlan,
  getPlanById,
  listPlans,
  getChildPlans,
  updatePlanStatus,
  updatePlanContent,
  insertEnvSnapshot,
  getEnvSnapshotById,
  getLatestEnvSnapshot,
  listEnvSnapshots,
  getSyncState,
  upsertSyncState,
  clearSyncState,
  upsertTranscriptUpload,
  getTranscriptUpload,
  getTranscriptUploadById,
  listPendingTranscriptUploads,
  markTranscriptUploaded,
  markTranscriptUploadFailed,
  resetTranscriptUpload,
  countActiveTranscriptUploads,
} from "./db/index.js";

export type {
  CreateSessionInput,
  InsertEventInput,
  EventQueryOptions,
  DiffRecord,
  CreatePlanInput,
  CreateEnvSnapshotInput,
  SyncState,
  TranscriptUpload,
  TranscriptUploadStatus,
  UpsertTranscriptUploadInput,
} from "./db/index.js";

// Config
export {
  loadConfig,
  findGitRoot,
  redactSensitiveKeys,
  type AditConfig,
} from "./config/index.js";

// Security — content-aware secret redaction
export {
  shannonEntropy,
  redactContent,
  redactObject,
  shouldSkipField,
  builtinPatterns,
  defaultSkipFields,
  type RedactionResult,
  type SecretDetection,
  type RedactionConfig,
  type SecretPattern,
} from "./security/content-redaction.js";

// Performance logging
export {
  recordPerf,
  withPerf,
  withPerfSync,
  readPerfLogs,
  generatePerfStats,
  clearPerfLogs,
  pruneOldLogs,
  type PerfEntry,
  type PerfOperationStats,
  type PerfStatsReport,
} from "./perf/perf-log.js";

// Sync primitives
export {
  generateId,
  generateIdAt,
  extractTimestamp,
  type VectorClock,
  createClock,
  tick,
  merge,
  compare,
  serialize,
  deserialize,
} from "./sync/index.js";
