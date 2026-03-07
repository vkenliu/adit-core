export { openDatabase, closeDatabase } from "./connection.js";
export { migrations } from "./migrations.js";

export {
  insertSession,
  getSessionById,
  getActiveSession,
  getSessionByPlatformSessionId,
  endSession,
  listSessions,
  type CreateSessionInput,
} from "./sessions.js";

export {
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
  clearEvents,
  countEvents,
  type InsertEventInput,
  type EventQueryOptions,
} from "./events.js";

export {
  insertDiff,
  getDiffByEventId,
  getDiffText,
  type DiffRecord,
} from "./diffs.js";

export {
  insertPlan,
  getPlanById,
  listPlans,
  getChildPlans,
  updatePlanStatus,
  updatePlanContent,
  type CreatePlanInput,
} from "./plans.js";

export {
  insertEnvSnapshot,
  getEnvSnapshotById,
  getLatestEnvSnapshot,
  listEnvSnapshots,
  type CreateEnvSnapshotInput,
} from "./env-snapshots.js";

export {
  getSyncState,
  upsertSyncState,
  clearSyncState,
  type SyncState,
} from "./sync-state.js";

export {
  upsertTranscriptUpload,
  getTranscriptUpload,
  getTranscriptUploadById,
  listPendingTranscriptUploads,
  markTranscriptUploaded,
  markTranscriptUploadFailed,
  resetTranscriptUpload,
  countActiveTranscriptUploads,
  type TranscriptUpload,
  type TranscriptUploadStatus,
  type UpsertTranscriptUploadInput,
} from "./transcript-uploads.js";
