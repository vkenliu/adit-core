/**
 * HTTP client for adit-cloud API.
 *
 * Handles Bearer auth, automatic token refresh, and exponential
 * backoff retry on network errors and 429 rate limits.
 */

import type { CloudCredentials } from "../auth/credentials.js";
import { isTokenExpired, saveCredentials } from "../auth/credentials.js";
import { CloudAuthError, CloudNetworkError, CloudApiError } from "./errors.js";

const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 2000;

export class CloudClient {
  private credentials: CloudCredentials;
  private readonly serverUrl: string;

  constructor(serverUrl: string, credentials: CloudCredentials) {
    this.serverUrl = serverUrl.replace(/\/$/, ""); // Strip trailing slash
    this.credentials = credentials;
  }

  /** GET request with auth */
  async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  /** HEAD request with auth — returns headers only */
  async head(path: string): Promise<Record<string, string>> {
    // Refresh token if expired before making the request (skip for static tokens)
    if (this.credentials.authType !== "token" && isTokenExpired(this.credentials)) {
      await this.refreshToken();
    }

    const url = `${this.serverUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.credentials.accessToken}`,
    };

    const response = await fetch(url, { method: "HEAD", headers });

    if (response.status === 401 || response.status === 403) {
      // Static tokens cannot be refreshed — fail immediately
      if (this.credentials.authType === "token") {
        throw new CloudAuthError(
          `Authentication failed: ${response.status} ${response.statusText}`,
        );
      }
      if (response.status === 401) {
        await this.refreshToken();
        // Retry once with new token
        const retry = await fetch(url, {
          method: "HEAD",
          headers: {
            Authorization: `Bearer ${this.credentials.accessToken}`,
          },
        });
        if (!retry.ok) {
          throw new CloudApiError(
            `HEAD ${path}: ${retry.status} ${retry.statusText}`,
            retry.status,
          );
        }
        return headersToRecord(retry.headers);
      }
      throw new CloudAuthError(
        `Authentication failed: ${response.status} ${response.statusText}`,
      );
    }

    if (!response.ok) {
      throw new CloudApiError(
        `HEAD ${path}: ${response.status} ${response.statusText}`,
        response.status,
      );
    }

    return headersToRecord(response.headers);
  }

  /** POST request with auth and JSON body */
  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  /** PATCH request with auth */
  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }

  /** DELETE request with auth */
  async delete(path: string): Promise<void> {
    await this.request<void>("DELETE", path);
  }

  /** Get the current credentials (may have been refreshed) */
  getCredentials(): CloudCredentials {
    return this.credentials;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    // Refresh token if expired before making the request (skip for static tokens)
    if (this.credentials.authType !== "token" && isTokenExpired(this.credentials)) {
      await this.refreshToken();
    }

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const backoffMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        await sleep(backoffMs);
      }

      try {
        const url = `${this.serverUrl}${path}`;
        const headers: Record<string, string> = {
          Authorization: `Bearer ${this.credentials.accessToken}`,
          "Content-Type": "application/json",
        };

        const response = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });

        // Handle 401 — static tokens cannot be refreshed, fail immediately
        if (response.status === 401 && this.credentials.authType === "token") {
          throw new CloudAuthError(
            `Authentication failed: ${response.status} ${response.statusText}`,
          );
        }

        // Handle 401 — try refreshing token once (device auth only)
        if (response.status === 401 && attempt === 0) {
          await this.refreshToken();
          continue; // Retry with new token
        }

        // Handle 429 rate limit — respect Retry-After header
        if (response.status === 429) {
          const retryAfter = response.headers.get("Retry-After");
          if (retryAfter) {
            const waitMs = parseInt(retryAfter, 10) * 1000;
            if (!isNaN(waitMs) && waitMs > 0) {
              await sleep(Math.min(waitMs, 60_000));
            }
          }
          continue; // Retry
        }

        if (!response.ok) {
          let responseBody: unknown;
          try {
            responseBody = await response.json();
          } catch {
            responseBody = await response.text();
          }

          if (response.status === 401 || response.status === 403) {
            throw new CloudAuthError(
              `Authentication failed: ${response.status} ${response.statusText}`,
            );
          }

          throw new CloudApiError(
            `API error: ${response.status} ${response.statusText}`,
            response.status,
            responseBody,
          );
        }

        // 204 No Content
        if (response.status === 204) {
          return undefined as T;
        }

        return (await response.json()) as T;
      } catch (error) {
        // Don't retry auth errors
        if (error instanceof CloudAuthError) throw error;
        if (error instanceof CloudApiError) throw error;

        // Network error — retry with backoff
        lastError =
          error instanceof Error
            ? error
            : new Error(String(error));
      }
    }

    throw new CloudNetworkError(
      `Request failed after ${MAX_RETRIES} retries: ${method} ${path}`,
      lastError,
    );
  }

  /** Refresh the access token using the refresh token */
  private async refreshToken(): Promise<void> {
    if (this.credentials.authType === "token") {
      throw new CloudAuthError(
        "Cannot refresh a static token. Re-authenticate with a new token or use 'adit cloud login'.",
      );
    }
    try {
      const response = await fetch(
        `${this.serverUrl}/api/auth/token/refresh`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            refreshToken: this.credentials.refreshToken,
          }),
        },
      );

      if (!response.ok) {
        throw new CloudAuthError(
          `Token refresh failed: ${response.status}. Please re-authenticate with 'adit cloud login'.`,
        );
      }

      const data = (await response.json()) as {
        accessToken: string;
        refreshToken: string;
        expiresAt: string;
      };

      this.credentials = {
        ...this.credentials,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresAt: data.expiresAt,
      };

      // Persist the refreshed credentials
      saveCredentials(this.credentials);
    } catch (error) {
      if (error instanceof CloudAuthError) throw error;
      throw new CloudAuthError(
        `Token refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}
