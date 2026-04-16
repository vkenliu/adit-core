/**
 * Bulk task status update command.
 *
 * Implements the bulk task status update functionality by calling
 * the /api/task-slices/bulk endpoint. Operates at phase or intent level only.
 */

import { CloudClient } from "../http/client.js";
import { CloudAuthError, CloudNetworkError, CloudApiError } from "../http/errors.js";
import type { BulkTaskUpdateOptions, BulkTaskUpdateResult } from "./types.js";

/**
 * Build the request body for bulk task update API
 */
function buildRequestBody(options: BulkTaskUpdateOptions) {
  const { intentId, status, filters } = options;

  // Always use wildcard — phase-level or intent-level only
  const updates = [
    {
      taskId: "*",
      status: status ?? "completed",
    },
  ];

  // Build the request body
  const body: {
    intentId: string;
    updates: Array<{
      taskId: string;
      status: string;
    }>;
    filters?: {
      phase?: number;
    };
  } = {
    intentId,
    updates,
  };

  // Add phase filter if provided
  if (filters?.phase !== undefined) {
    body.filters = { phase: filters.phase };
  }

  return body;
}

/**
 * Validate options and prepare for API call
 */
function validateOptions(options: BulkTaskUpdateOptions): void {
  if (!options.intentId) {
    throw new Error("intentId is required");
  }

  // Validate intentId format (basic UUID check)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.intentId)) {
    throw new Error("Invalid intentId format");
  }

  // Validate status if provided
  if (options.status && !["pending", "approved", "in_progress", "completed", "rejected"].includes(options.status)) {
    throw new Error(`Invalid status: ${options.status}. Must be one of: pending, approved, in_progress, completed, rejected`);
  }

  // Validate phase filter
  if (options.filters?.phase && (options.filters.phase < 1 || options.filters.phase > 99)) {
    throw new Error("Phase must be between 1 and 99");
  }
}

/**
 * Bulk task status update command
 *
 * Updates task status in bulk using the /api/task-slices/bulk endpoint.
 */
export async function bulkTaskUpdateCommand(
  client: CloudClient,
  _projectId: string,
  options: BulkTaskUpdateOptions
): Promise<BulkTaskUpdateResult> {
  try {
    // Validate options first
    validateOptions(options);

    // Build request body
    const body = buildRequestBody(options);

    // Make the API request
    const result = await client.patch<BulkTaskUpdateResult>(
      `/api/task-slices/bulk`,
      body
    );

    return result;
  } catch (error) {
    if (error instanceof CloudAuthError) {
      throw error;
    }
    if (error instanceof CloudNetworkError) {
      throw error;
    }
    if (error instanceof CloudApiError) {
      // Enhance API error with more context
      throw new CloudApiError(
        `Bulk task update failed: ${error.message}`,
        error.status,
        error.body
      );
    }

    // Re-throw validation errors
    if (error instanceof Error) {
      throw error;
    }

    throw new CloudApiError("Bulk task update failed with unknown error", 500);
  }
}
