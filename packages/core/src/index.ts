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
  endSession,
  listSessions,
  insertEvent,
  getEventById,
  queryEvents,
  getEventsBySession,
  updateEventStatus,
  updateEventCheckpoint,
  updateEventLabels,
  allocateSequence,
  searchEvents,
  getLatestCheckpointEvent,
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
} from "./db/index.js";

export type {
  CreateSessionInput,
  InsertEventInput,
  EventQueryOptions,
  DiffRecord,
  CreatePlanInput,
  CreateEnvSnapshotInput,
} from "./db/index.js";

// Config
export {
  loadConfig,
  findGitRoot,
  redactSensitiveKeys,
  type AditConfig,
} from "./config/index.js";

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
