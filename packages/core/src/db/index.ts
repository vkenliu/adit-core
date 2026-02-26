export { openDatabase, closeDatabase } from "./connection.js";
export { migrations } from "./migrations.js";

export {
  insertSession,
  getSessionById,
  getActiveSession,
  endSession,
  listSessions,
  type CreateSessionInput,
} from "./sessions.js";

export {
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
