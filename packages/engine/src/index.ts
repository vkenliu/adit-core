/**
 * @adit/engine — Git operations, snapshots, detection, timeline, and environment capture.
 */

// Git operations
export {
  runGit,
  runGitOrThrow,
  getHeadSha,
  getCurrentBranch,
  getRemoteUrl,
  isGitRepo,
  type GitResult,
  type GitRunOptions,
} from "./git/runner.js";

export {
  storeCheckpointRef,
  resolveCheckpointRef,
  deleteCheckpointRef,
  listCheckpointRefs,
  getParentSha,
  getRefPrefix,
} from "./git/refs.js";

// Working tree detection
export {
  getChangedFiles,
  hasUncommittedChanges,
  getNumstat,
  getChangesSummary,
  isDirtyFrom,
  type FileChange,
  type NumstatEntry,
} from "./detector/working-tree.js";

// Snapshot creation
export {
  createSnapshot,
  getCheckpointDiff,
  type SnapshotResult,
} from "./snapshot/creator.js";

// Timeline management
export {
  createTimelineManager,
  type TimelineManager,
  type RecordEventParams,
  type ListOptions,
} from "./timeline/manager.js";

// Environment capture & diffing
export { captureEnvironment, type PreComputedGitState } from "./environment/capture.js";
export { diffEnvironments } from "./environment/differ.js";
