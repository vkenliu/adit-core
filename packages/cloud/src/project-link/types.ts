/**
 * Type definitions for the Project Link feature.
 *
 * Covers git metadata collection, document discovery, local cache,
 * server API request/response shapes, and command options.
 */

// ─── Git Collection ────────────────────────────────────────

export interface GitBranch {
  name: string;
  headSha: string;
  isDefault: boolean;
}

export interface GitCommit {
  sha: string;
  authorName: string;
  authorEmail: string;
  date: string; // ISO 8601
  message: string;
  branch?: string;
}

// ─── Document Discovery ────────────────────────────────────

export interface DiscoveredDocument {
  /** File name (e.g. "README.md") */
  fileName: string;
  /** Relative path from project root (e.g. "docs/architecture.md") */
  sourcePath: string;
  /** Full file content */
  content: string;
  /** SHA-256 hex digest of content */
  contentHash: string;
  /** File size in bytes */
  sizeBytes: number;
  /** Status relative to the cached hash */
  status: "new" | "changed" | "unchanged";
}

// ─── Local Cache ───────────────────────────────────────────

export interface ProjectLinkCache {
  projectId: string;
  serverUrl: string;
  confirmedProjectId: string | null;
  lastCommitSha: string | null;
  lastBranchSyncAt: string | null;
  lastDocSyncAt: string | null;
  docHashes: Record<string, string>; // sourcePath → contentHash
  qualified: boolean;
  initializedAt: string;
  updatedAt: string;
}

// ─── Server API Responses ──────────────────────────────────

export interface NegotiateResponse {
  confirmedProjectId: string;
  projectName: string;
  status: "confirmed" | "id_mismatch";
  message: string;
}

export interface LinkInitResponse {
  projectLink: {
    id: string;
    projectId: string;
    remoteUrl: string;
    defaultBranch: string | null;
    branchCount: number;
    qualified: boolean;
    lastGitSyncAt: string | null;
    lastDocSyncAt: string | null;
    createdAt: string;
  };
  status: "created" | "updated";
}

export interface CommitUploadResponse {
  accepted: number;
  duplicates: number;
  totalCommits: number;
  latestCommitSha: string;
}

export interface DocumentUploadResponse {
  results: Array<{
    fileName: string;
    documentId: string;
    status: "created" | "new_version" | "unchanged";
    versionNumber?: number;
  }>;
  summary: {
    created: number;
    updated: number;
    unchanged: number;
    total: number;
  };
}

export interface QualifyDocumentDetail {
  fileName: string;
  detectedType: string;
  structuralScore: number;
  missingSections: string[];
  hasStubContent: boolean;
}

export interface QualifyResponse {
  qualified: boolean;
  score: number;
  documentCount: number;
  documentDetails?: QualifyDocumentDetail[];
  feedback: {
    missing: string[];
    suggestions: string[];
    summaryPrompt: string;
  } | null;
}

export interface LinkStatusResponse {
  projectLink: {
    id: string;
    projectId: string;
    remoteUrl: string;
    defaultBranch: string | null;
    qualified: boolean;
    lastGitSyncAt: string | null;
    lastDocSyncAt: string | null;
    createdAt: string;
  };
  branchCount: number;
  commitCount: number;
  latestCommitSha: string | null;
  latestCommitDate: string | null;
  documentCount: number;
  documents: Array<{
    fileName: string;
    contentHash: string;
    updatedAt: string;
  }>;
}

// ─── Intent Types ──────────────────────────────────────────

export interface IntentSummary {
  id: string;
  title: string;
  businessGoal: string;
  state: string;
  ambiguityScore: number | null;
  linkedBranches: string[];
  taskCount: number;
  completedTaskCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface IntentDetail extends IntentSummary {
  acceptanceMd: string | null;
  antiGoals: string | null;
  clarityScores: {
    goal: number;
    constraints: number;
    criteria: number;
    context: number;
  } | null;
  tasks: TaskSlice[];
  latestPlan: {
    version: number;
    versionType: string;
    responsePayload: string;
    gatekeeperVerdict: string | null;
    createdAt: string;
  } | null;
  recentShipNotes: Array<{
    id: string;
    noteBody: string;
    createdBy: string;
    architecturalDecision: boolean;
    createdAt: string;
  }>;
}

export interface TaskSlice {
  id: string;
  title: string;
  description: string | null;
  phase: number;
  phaseTitle: string | null;
  sortOrder: number;
  wave: number | null;
  complexityScore: number | null;
  approvalStatus: string;
  featureTag: string | null;
  acceptanceCriteria: string[];
  dependsOn: number[];
  codingPrompt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Command Options ───────────────────────────────────────

export interface LinkOptions {
  force?: boolean;
  skipDocs?: boolean;
  skipCommits?: boolean;
  skipQualify?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export interface IntentOptions {
  id?: string;
  state?: string;
  json?: boolean;
}

// ─── Step Timing ───────────────────────────────────────────

export interface StepTiming {
  /** Human-readable step name (e.g. "Negotiate project ID") */
  step: string;
  /** Duration in milliseconds */
  durationMs: number;
}

// ─── Command Results ───────────────────────────────────────

export interface LinkResult {
  projectId: string;
  projectName: string;
  serverUrl: string;
  branchCount: number;
  commitCount: number;
  documentCount: number;
  qualified: boolean;
  score: number | null;
  /** Per-step timing breakdown */
  stepTimings: StepTiming[];
  /** Total wall-clock duration in milliseconds */
  totalDurationMs: number;
}

export interface IntentResult {
  intents?: IntentSummary[];
  intent?: IntentDetail;
}

// ─── Bulk Task Update Types ─────────────────────────────────

export interface BulkTaskFilter {
  /** Filter by phase number (1-99) */
  phase?: number;
  /** Filter by task status */
  status?: "pending" | "approved" | "in_progress" | "completed" | "rejected";
  /** Filter by feature tag */
  featureTag?: string;
  /** Filter by wave number */
  wave?: number;
}

export interface BulkTaskUpdate {
  /** Task ID to update */
  taskId: string;
  /** New status for the task */
  status: "pending" | "approved" | "in_progress" | "completed" | "rejected";
  /** Optional phase number */
  phase?: number;
  /** Optional title update */
  title?: string;
  /** Optional description update */
  description?: string;
}

export interface BulkTaskUpdateOptions {
  /** Intent ID containing the tasks to update */
  intentId: string;
  /** Specific tasks to update (when not provided, all tasks in intent are updated) */
  taskId?: string[];
  /** Target status (default: "completed") */
  status?: "pending" | "approved" | "in_progress" | "completed" | "rejected";
  /** Filters to apply before updating */
  filters?: BulkTaskFilter;
  /** Output as JSON */
  json?: boolean;
}

export interface BulkTaskUpdateResult {
  /** Number of tasks successfully updated */
  updated: number;
  /** Array of failed updates with error details */
  failed: Array<{
    taskId: string;
    error: string;
  }>;
  /** Summary message */
  message: string;
}
