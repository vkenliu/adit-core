/**
 * @adit/cloud — Cloud sync client for ADIT.
 *
 * Provides device authorization, HTTP client with auto-refresh,
 * cursor-based incremental sync engine, and conflict resolution.
 */

// Config
export { loadCloudConfig, DEFAULT_SERVER_URL, type CloudConfig, type ProjectLinkConfig } from "./config.js";

// Auth
export {
  loadCredentials,
  saveCredentials,
  clearCredentials,
  isTokenExpired,
  credentialsFromEnvToken,
  incrementSyncErrors,
  clearSyncErrors,
  isSyncDisabled,
  type CloudCredentials,
} from "./auth/credentials.js";
export {
  requestDeviceCode,
  pollForToken,
  type DeviceCodeResponse,
  type TokenResponse,
  type DeviceAuthOptions,
} from "./auth/device-auth.js";

// HTTP
export { CloudClient } from "./http/client.js";
export {
  CloudAuthError,
  CloudNetworkError,
  CloudApiError,
} from "./http/errors.js";

// Sync
export {
  SyncEngine,
  type SyncResult,
  type SyncConflict,
} from "./sync/engine.js";
export {
  buildSyncBatch,
  countUnsyncedRecords,
  batchRecordCount,
  type SyncBatch,
} from "./sync/serializer.js";
export { triggerAutoSync } from "./sync/auto-sync.js";

// Transcript / file upload
export {
  triggerTranscriptUpload,
  registerTranscript,
  processTranscriptUploads,
  uploadChunk,
  uploadFull,
  checkUploadStatus,
  lookupUploadByPath,
  type TranscriptManagerOptions,
  type TranscriptProcessResult,
  type SyncUploadType,
  type SyncUploadResponse,
  type SyncUploadStatus,
  type UploadChunkParams,
} from "./transcript/index.js";

export { type TranscriptUploadConfig } from "./config.js";

// Project Link
export {
  linkCommand,
  intentCommand,
  formatIntentList,
  formatIntentDetail,
  triggerProjectLinkSync,
  checkQuality,
  formatQualityFeedback,
  collectRemoteUrl,
  collectBranches,
  collectCommitLogs,
  collectCommitCount,
  collectDefaultBranch,
  collectCurrentBranch,
  projectNameFromRemoteUrl,
  discoverDocuments,
  loadDocSettings,
  getProjectLinkCache,
  upsertProjectLinkCache,
  clearProjectLinkCache,
  type LinkResult,
  type IntentResult,
  type LinkOptions,
  type IntentOptions,
  type IntentSummary,
  type IntentDetail,
  type TaskSlice,
  type StepTiming,
  type GitBranch,
  type GitCommit,
  type DiscoveredDocument,
  type ProjectLinkCache,
  type QualifyResponse,
} from "./project-link/index.js";
