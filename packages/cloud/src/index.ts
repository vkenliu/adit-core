/**
 * @adit/cloud — Cloud sync client for ADIT.
 *
 * Provides device authorization, HTTP client with auto-refresh,
 * cursor-based incremental sync engine, and conflict resolution.
 */

// Config
export { loadCloudConfig, DEFAULT_SERVER_URL, type CloudConfig } from "./config.js";

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
