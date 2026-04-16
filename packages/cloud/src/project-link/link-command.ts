/**
 * Project link command handler — orchestrates the 6-step link flow.
 *
 * Steps:
 *   1. Check credentials (handled by caller)
 *   2. Negotiate project ID with server
 *   3. Upload git metadata (branches + commits)
 *   4. Discover project documents
 *   5. Upload documents (with user confirmation in interactive mode)
 *   6. Quality check (and optional AI summary generation)
 */

import type Database from "better-sqlite3";
import type { CloudClient } from "../http/client.js";
import type {
  LinkOptions,
  LinkResult,
  StepTiming,
  NegotiateResponse,
  LinkInitResponse,
  CommitUploadResponse,
  DocumentUploadResponse,
  DiscoveredDocument,
} from "./types.js";
import {
  collectRemoteUrl,
  collectDefaultBranch,
  collectBranches,
  collectCommitLogs,
  collectCommitCount,
  resolveCommitBranches,
  projectNameFromRemoteUrl,
} from "./git-collector.js";
import { discoverDocuments, loadDocSettings } from "./doc-discovery.js";
import {
  getProjectLinkCache,
  upsertProjectLinkCache,
  clearProjectLinkCache,
  updateCachedCommitSha,
  updateCachedDocHashes,
  updateCachedQualified,
} from "./cache.js";
import { checkQuality, formatQualityFeedback } from "./qualify.js";
import { validateDocument } from "@varveai/adit-plans";

/** Maximum number of commits per upload batch */
const COMMIT_BATCH_SIZE = 1000;

/** Minimum staleness before re-uploading branches (1 hour) */
const BRANCH_STALE_MS = 60 * 60 * 1000;

/**
 * Execute the project link flow.
 *
 * The caller is responsible for:
 * - Loading credentials and verifying authentication
 * - Creating the CloudClient with a valid server URL
 * - Opening the database
 *
 * Returns a LinkResult summarizing what was done.
 */
export async function linkCommand(
  db: Database.Database,
  client: CloudClient,
  projectRoot: string,
  projectId: string,
  serverUrl: string,
  options: LinkOptions = {},
): Promise<LinkResult> {
  // In JSON mode, suppress progress output
  const log = options.json ? (() => {}) : console.log.bind(console);

  // Step timing tracker
  const totalStart = performance.now();
  const stepTimings: StepTiming[] = [];

  function startStep(): number {
    return performance.now();
  }

  function endStep(stepName: string, stepStart: number): void {
    stepTimings.push({ step: stepName, durationMs: Math.round(performance.now() - stepStart) });
  }

  // Handle --force: clear local cache and server data
  if (options.force) {
    log("Clearing cached link data...");
    clearProjectLinkCache(db, projectId, serverUrl);
    try {
      await client.delete(
        `/api/project-link/reset?projectId=${encodeURIComponent(projectId)}`,
      );
      log("Server link data cleared.");
    } catch {
      // Server reset may fail if no link exists yet — that's fine
    }
  }

  // Load or initialize cache
  let cache = getProjectLinkCache(db, projectId, serverUrl);

  // ──────────────────────────────────────────────────────────
  // Step 2: Negotiate project ID
  // ──────────────────────────────────────────────────────────

  log("\n[Step 1/6] Negotiating project ID with server...");
  const step1Start = startStep();

  const remoteUrl = await collectRemoteUrl(projectRoot);
  const projectName = projectNameFromRemoteUrl(remoteUrl);
  let confirmedProjectId = cache?.confirmedProjectId ?? null;

  if (!confirmedProjectId || options.force) {
    const negotiate = await client.post<NegotiateResponse>(
      "/api/project-link/negotiate",
      { projectId, remoteUrl, projectName },
    );

    confirmedProjectId = negotiate.confirmedProjectId;

    if (negotiate.status === "id_mismatch") {
      log(`  Server found existing project with different ID. Adopting: ${confirmedProjectId}`);
    }

    log(`  Project confirmed: ${negotiate.projectName} (${confirmedProjectId.slice(0, 12)}...)`);

    // Initialize or update cache
    const now = new Date().toISOString();
    if (!cache) {
      cache = {
        projectId,
        serverUrl,
        confirmedProjectId,
        lastCommitSha: null,
        lastBranchSyncAt: null,
        lastDocSyncAt: null,
        docHashes: {},
        qualified: false,
        initializedAt: now,
        updatedAt: now,
      };
      upsertProjectLinkCache(db, cache);
    } else {
      cache.confirmedProjectId = confirmedProjectId;
      cache.updatedAt = now;
      upsertProjectLinkCache(db, cache);
    }
  } else {
    log(`  Project confirmed: ${projectName} (${confirmedProjectId.slice(0, 12)}...)`);
  }

  // At this point cache is guaranteed non-null: either loaded from DB
  // (else branch) or freshly created (if branch). Assert for TypeScript.
  if (!cache) {
    throw new Error("Internal error: project link cache not initialized after negotiate");
  }

  // Use the confirmed project ID for all subsequent API calls
  const effectiveProjectId = confirmedProjectId;
  endStep("Negotiate project ID", step1Start);

  // ──────────────────────────────────────────────────────────
  // Step 3: Upload git metadata (branches + commits)
  // ──────────────────────────────────────────────────────────

  log("\n[Step 2/6] Uploading git metadata...");
  const step2Start = startStep();

  // 3a. Branches — collect once and reuse for commit branch resolution
  const branchesStale = !cache.lastBranchSyncAt ||
    (Date.now() - new Date(cache.lastBranchSyncAt).getTime() > BRANCH_STALE_MS) ||
    options.force;

  const allBranches = await collectBranches(projectRoot);
  const defaultBranch = await collectDefaultBranch(projectRoot);
  let branchCount = 0;

  if (branchesStale) {
    if (options.dryRun) {
      log(`  [dry-run] Would upload ${allBranches.length} branches, default: ${defaultBranch ?? "unknown"}`);
      branchCount = allBranches.length;
    } else {
      const initResponse = await client.post<LinkInitResponse>(
        "/api/project-link/init",
        {
          projectId: effectiveProjectId,
          remoteUrl,
          defaultBranch,
          branches: allBranches.map((b) => ({
            name: b.name,
            headSha: b.headSha,
          })),
        },
      );
      branchCount = initResponse.projectLink.branchCount;
      cache.lastBranchSyncAt = new Date().toISOString();
      upsertProjectLinkCache(db, cache);
      log(`  ${branchCount} branches, default: ${defaultBranch ?? "unknown"}`);
    }
  } else {
    log("  Branches up to date (synced < 1 hour ago)");
  }

  // 3b. Commits
  let commitCount = 0;

  if (!options.skipCommits) {
    // Collect commits and resolve per-commit branch assignment by checking
    // which branches each commit is reachable from. Non-default branches
    // take priority so merged feature-branch commits keep their origin.
    const commits = await collectCommitLogs(projectRoot, {
      sinceCommitSha: cache.lastCommitSha,
    });
    const totalCommits = await collectCommitCount(projectRoot);

    // Resolve branch for each commit using collected branch data
    if (commits.length > 0) {
      await resolveCommitBranches(projectRoot, commits, allBranches, defaultBranch);
    }

    if (commits.length === 0) {
      log("  No new commits to upload.");
      commitCount = totalCommits;
    } else if (options.dryRun) {
      log(`  [dry-run] Would upload ${commits.length} commits (${totalCommits} total)`);
      commitCount = totalCommits;
    } else {
      // Upload in batches
      let uploaded = 0;
      for (let i = 0; i < commits.length; i += COMMIT_BATCH_SIZE) {
        const batch = commits.slice(i, i + COMMIT_BATCH_SIZE);
        const response = await client.post<CommitUploadResponse>(
          "/api/project-link/commits",
          {
            projectId: effectiveProjectId,
            sinceCommitSha: cache.lastCommitSha,
            commits: batch.map((c) => ({
              sha: c.sha,
              authorName: c.authorName,
              authorEmail: c.authorEmail,
              date: c.date,
              message: c.message,
              branch: c.branch,
            })),
          },
        );
        uploaded += response.accepted;
        commitCount = response.totalCommits;

        // Show progress for large uploads
        if (commits.length > COMMIT_BATCH_SIZE) {
          const done = Math.min(i + COMMIT_BATCH_SIZE, commits.length);
          log(`  Uploading commits... ${done}/${commits.length}`);
        }
      }

      // Update cache with latest commit SHA
      if (commits.length > 0) {
        updateCachedCommitSha(db, effectiveProjectId, serverUrl, commits[0].sha);
        cache.lastCommitSha = commits[0].sha;
      }

      log(`  ${uploaded} new commits uploaded (${commitCount} total)`);
    }
  } else {
    log("  Skipping commit history (--skip-commits)");
  }
  endStep("Upload git metadata", step2Start);

  // ──────────────────────────────────────────────────────────
  // Step 4: Discover project documents
  // ──────────────────────────────────────────────────────────

  let documentCount = 0;
  let discoveredDocs: DiscoveredDocument[] = [];
  const step3Start = startStep();

  if (!options.skipDocs) {
    log("\n[Step 3/6] Discovering project documents...");

    const docSettings = loadDocSettings(projectRoot);
    discoveredDocs = discoverDocuments(projectRoot, cache.docHashes, docSettings);

    if (discoveredDocs.length === 0) {
      log("  No documents found matching patterns.");
    } else {
      log(`  Found ${discoveredDocs.length} document${discoveredDocs.length !== 1 ? "s" : ""}:`);
      for (const doc of discoveredDocs) {
        const sizeKB = (doc.sizeBytes / 1024).toFixed(1);
        const tag = doc.status === "new" ? "[NEW]    " :
          doc.status === "changed" ? "[CHANGED]" :
            "[SKIP]   ";
        log(`    ${tag} ${doc.sourcePath} (${sizeKB} KB)`);
      }

      // Warn if many documents matched
      if (discoveredDocs.length > 50) {
        log(`\n  Warning: ${discoveredDocs.length} documents found. Consider narrowing patterns in settings.json`);
      }

      // ── Local structural validation ────────────────────────
      const threshold = 0.6;
      const newOrChanged = discoveredDocs.filter((d) => d.status !== "unchanged");
      if (newOrChanged.length > 0) {
        log("\n  Validating document structure...");
        for (const doc of newOrChanged) {
          const result = validateDocument(doc.content);
          const scorePct = Math.round(result.score * 100);
          if (result.score < threshold) {
            log(`    [WARN] ${doc.sourcePath} — score ${scorePct}% (type: ${result.detectedType})`);
            for (const s of result.missingRequired) {
              log(`           Missing required: ## ${s}`);
            }
            for (const s of result.stubSections) {
              log(`           Stub section: ## ${s}`);
            }
          } else {
            log(`    [OK]   ${doc.sourcePath} — score ${scorePct}% (type: ${result.detectedType})`);
          }
        }
        log("  Tip: Use 'adit docs validate' for a detailed report, or run your");
        log("       AI coding tool's generate-docs skill to fill in missing sections.");
      }
    }

    // ──────────────────────────────────────────────────────────
    // Step 5: Upload documents
    // ──────────────────────────────────────────────────────────

    const toUpload = discoveredDocs.filter((d) => d.status !== "unchanged");

    if (toUpload.length === 0) {
      log("\n[Step 4/6] All documents up to date.");
      documentCount = discoveredDocs.length;
    } else if (options.dryRun) {
      log(`\n[Step 4/6] [dry-run] Would upload ${toUpload.length} document${toUpload.length !== 1 ? "s" : ""}`);
      documentCount = discoveredDocs.length;
    } else {
      log(`\n[Step 4/6] Uploading ${toUpload.length} document${toUpload.length !== 1 ? "s" : ""}...`);

      const response = await client.post<DocumentUploadResponse>(
        "/api/project-link/documents",
        {
          projectId: effectiveProjectId,
          documents: toUpload.map((d) => ({
            fileName: d.fileName,
            sourcePath: d.sourcePath,
            content: d.content,
            contentHash: d.contentHash,
          })),
        },
      );

      const s = response.summary;
      log(`  ${s.total} documents processed (${s.created} new, ${s.updated} updated, ${s.unchanged} unchanged)`);
      documentCount = discoveredDocs.length;

      // Update cached hashes
      const newHashes = { ...cache.docHashes };
      for (const doc of discoveredDocs) {
        newHashes[doc.sourcePath] = doc.contentHash;
      }
      updateCachedDocHashes(db, effectiveProjectId, serverUrl, newHashes);
      cache.docHashes = newHashes;
    }
  } else {
    log("\n[Step 3/6] Skipping document upload (--skip-docs)");
    log("\n[Step 4/6] Skipping document upload (--skip-docs)");
  }
  endStep("Discover & upload documents", step3Start);

  // ──────────────────────────────────────────────────────────
  // Step 6: Quality check
  // ──────────────────────────────────────────────────────────

  let qualified = cache.qualified;
  let score: number | null = null;
  const step5Start = startStep();

  if (!options.skipDocs && !options.dryRun && !options.skipQualify) {
    log("\n[Step 5/6] Checking document quality...");

    const qualifyResult = await checkQuality(client, effectiveProjectId);
    qualified = qualifyResult.qualified;
    score = qualifyResult.score;

    if (qualified) {
      log(`  Documents qualified (score: ${score!.toFixed(2)})`);
    } else {
      log(`  Documents not yet qualified (score: ${score!.toFixed(2)})`);
    }

    // Always show document quality feedback (even when qualified)
    const feedback = formatQualityFeedback(qualifyResult);
    if (feedback) {
      log(feedback);
    }

    // Show summary prompt when not qualified
    if (!qualified && qualifyResult.feedback?.summaryPrompt) {
      log("");
      log(`  ${qualifyResult.feedback.summaryPrompt}`);
    }

    updateCachedQualified(db, effectiveProjectId, serverUrl, qualified);
    cache.qualified = qualified;
  } else {
    log("\n[Step 5/6] Skipping quality check");
  }
  endStep("Quality check", step5Start);

  const totalDurationMs = Math.round(performance.now() - totalStart);

  // ──────────────────────────────────────────────────────────
  // Final: Summary
  // ──────────────────────────────────────────────────────────

  const qualifiedLabel = qualified ? "qualified" : "not qualified";

  log("");
  log("══════════════════════════════════════════");
  log("Project link complete!");
  log(`Project:    ${projectName}`);
  log(`Server:     ${serverUrl}`);
  log(`Branches:   ${branchCount}`);
  log(`Commits:    ${commitCount}`);
  log(`Documents:  ${documentCount} (${qualifiedLabel})`);
  log("──────────────────────────────────────────");
  for (const t of stepTimings) {
    log(`  ${t.step.padEnd(28)} ${formatDuration(t.durationMs)}`);
  }
  log(`  ${"Total".padEnd(28)} ${formatDuration(totalDurationMs)}`);
  log("══════════════════════════════════════════");

  return {
    projectId: effectiveProjectId,
    projectName,
    serverUrl,
    branchCount,
    commitCount,
    documentCount,
    qualified,
    score,
    stepTimings,
    totalDurationMs,
  };
}

/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * Examples: "42ms", "1.2s", "2m 3s"
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}
