/**
 * HTTP client for adit-cloud API.
 *
 * Handles Bearer auth, automatic token refresh, and exponential
 * backoff retry on network errors and 429 rate limits.
 */

import type { CloudCredentials } from "../auth/credentials.js";
import {
  clearAuthFailure,
  isTokenExpired,
  loadCredentials,
  recordAuthFailure,
  saveCredentials,
  withCredentialsRefreshLock,
} from "../auth/credentials.js";
import { CloudAuthError, CloudNetworkError, CloudApiError } from "./errors.js";

const MAX_RETRIES = 5;
const MAX_REDIRECTS = 5;
const INITIAL_BACKOFF_MS = 2000;

interface TokenRefreshResponse {
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  expiresAt?: string;
  expiresIn?: number;
}

export interface RefreshTokenStatus {
  valid: boolean;
  reason?: string;
  message?: string;
  status?: number;
  clientId?: string;
  userId?: string;
  expiresAt?: string;
  revokedAt?: string;
  client?: {
    id: string;
    displayName: string;
    platform: string | null;
    isActive: boolean;
    lastSeenAt: string | null;
  };
}

export class CloudClient {
  private credentials: CloudCredentials;
  private readonly serverUrl: string;

  constructor(serverUrl: string, credentials: CloudCredentials) {
    this.serverUrl = serverUrl.replace(/\/$/, "");
    this.credentials = credentials;
  }

  /** GET request with auth */
  async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  /** HEAD request with auth — returns headers only */
  async head(path: string): Promise<Record<string, string>> {
    await this.ensureFreshToken();

    const url = `${this.serverUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.credentials.accessToken}`,
    };

    const response = await fetch(url, { method: "HEAD", headers });

    if (response.status === 401 || response.status === 403) {
      if (this.credentials.authType === "token") {
        this.recordRequestAuthFailure(response.status, response.statusText);
        throw new CloudAuthError(
          `Authentication failed: ${response.status} ${response.statusText}`,
        );
      }
      if (response.status === 401) {
        await this.refreshToken(true);
        const retry = await fetch(url, {
          method: "HEAD",
          headers: {
            Authorization: `Bearer ${this.credentials.accessToken}`,
          },
        });
        if (!retry.ok) {
          if (retry.status === 401 || retry.status === 403) {
            this.recordRequestAuthFailure(retry.status, retry.statusText);
            throw new CloudAuthError(
              `Authentication failed: ${retry.status} ${retry.statusText}`,
            );
          }
          throw new CloudApiError(
            `HEAD ${path}: ${retry.status} ${retry.statusText}`,
            retry.status,
          );
        }
        clearAuthFailure();
        return headersToRecord(retry.headers);
      }
      this.recordRequestAuthFailure(response.status, response.statusText);
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

    clearAuthFailure();
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

  /** Refresh credentials if needed and return the current token set. */
  async getFreshCredentials(): Promise<CloudCredentials> {
    await this.ensureFreshToken();
    return this.credentials;
  }

  /** Check refresh-token health without rotating it. */
  async getRefreshTokenStatus(): Promise<RefreshTokenStatus> {
    if (this.credentials.authType === "token") {
      return {
        valid: true,
        reason: "static_token",
        message: "Static token auth does not use refresh tokens.",
      };
    }

    try {
      const response = await fetch(`${this.serverUrl}/api/auth/token/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: this.credentials.refreshToken }),
      });
      const body = await readResponseBody(response);
      const record = asRecord(body);

      if (!response.ok) {
        return {
          valid: false,
          status: response.status,
          reason: readString(record.reason) ?? readString(record.code) ?? "unknown",
          message: readString(record.error) ?? response.statusText,
          clientId: readString(record.clientId),
          expiresAt: readString(record.expiresAt),
          revokedAt: readString(record.revokedAt),
        };
      }

      return {
        valid: record.valid === true,
        reason: readString(record.reason),
        message: readString(record.error),
        clientId: readString(record.clientId),
        userId: readString(record.userId),
        expiresAt: readString(record.expiresAt),
        client: asRefreshTokenStatusClient(record.client),
      };
    } catch (error) {
      if (error instanceof CloudApiError || error instanceof CloudAuthError) throw error;
      throw new CloudNetworkError(
        `Refresh token status check failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    redirectCount = 0,
  ): Promise<T> {
    await this.ensureFreshToken();

    let lastError: Error | undefined;
    let currentUrl = `${this.serverUrl}${path}`;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const backoffMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        await sleep(backoffMs);
      }

      try {
        const url = currentUrl;
        const headers: Record<string, string> = {
          Authorization: `Bearer ${this.credentials.accessToken}`,
          "Content-Type": "application/json",
        };

        const response = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });

        if (response.status === 401 && this.credentials.authType === "token") {
          this.recordRequestAuthFailure(response.status, response.statusText);
          throw new CloudAuthError(
            `Authentication failed: ${response.status} ${response.statusText}`,
          );
        }

        if (response.status === 401 && attempt === 0) {
          await this.refreshToken(true);
          continue;
        }

        if (response.status === 429) {
          const retryAfter = response.headers.get("Retry-After");
          if (retryAfter) {
            const waitMs = parseInt(retryAfter, 10) * 1000;
            if (!isNaN(waitMs) && waitMs > 0) {
              await sleep(Math.min(waitMs, 60_000));
            }
          }
          continue;
        }

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("Location");
          if (!location) {
            throw new CloudApiError("Redirect missing Location header", response.status);
          }

          if (redirectCount >= MAX_REDIRECTS) {
            throw new CloudNetworkError(
              `Too many redirects (max ${MAX_REDIRECTS}) for ${method} ${path}`,
            );
          }

          const redirectUrl = new URL(location, url);
          const effectiveMethod = response.status === 303 ? "GET" : method;
          currentUrl = redirectUrl.toString();
          method = effectiveMethod;

          if (response.status === 303 || effectiveMethod === "GET" || effectiveMethod === "HEAD") {
            body = undefined;
          }

          return this.request(method, path, body, redirectCount + 1);
        }

        if (!response.ok) {
          const responseBody = await readResponseBody(response);

          if (response.status === 401 || response.status === 403) {
            this.recordRequestAuthFailure(
              response.status,
              response.statusText,
              readBodyCode(responseBody),
            );
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

        clearAuthFailure();
        if (response.status === 204) {
          return undefined as T;
        }

        return (await response.json()) as T;
      } catch (error) {
        if (error instanceof CloudAuthError) throw error;
        if (error instanceof CloudApiError) throw error;

        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw new CloudNetworkError(
      `Request failed after ${MAX_RETRIES} retries: ${method} ${path}`,
      lastError,
    );
  }

  private async ensureFreshToken(): Promise<void> {
    if (this.credentials.authType !== "token" && isTokenExpired(this.credentials)) {
      await this.refreshToken(false);
    }
  }

  /** Refresh the access token using the refresh token. */
  private async refreshToken(force: boolean): Promise<void> {
    if (this.credentials.authType === "token") {
      throw new CloudAuthError(
        "Cannot refresh a static token. Re-authenticate with a new token or use 'adit cloud login'.",
      );
    }

    await withCredentialsRefreshLock(async () => {
      const original = this.credentials;
      const stored = loadCredentials();
      if (
        stored &&
        stored.authType !== "token" &&
        stored.clientId === original.clientId &&
        this.sameServer(stored.serverUrl)
      ) {
        this.credentials = stored;
        const tokenChanged =
          stored.accessToken !== original.accessToken ||
          stored.refreshToken !== original.refreshToken;
        if ((tokenChanged || !force) && !isTokenExpired(stored)) {
          return;
        }
      }

      try {
        const response = await fetch(`${this.serverUrl}/api/auth/token/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            refreshToken: this.credentials.refreshToken,
          }),
        });

        const data = await readResponseBody(response);
        if (!response.ok) {
          const code = readBodyCode(data);
          const message = `Token refresh failed: ${response.status}. Please re-authenticate with 'adit cloud login'.`;
          recordAuthFailure({
            stage: "refresh",
            message,
            status: response.status,
            code,
          });
          throw new CloudAuthError(message);
        }

        const tokenData = asRecord(data) as TokenRefreshResponse;
        const accessToken = readString(tokenData.accessToken);
        const refreshToken = readString(tokenData.refreshToken);
        if (!accessToken || !refreshToken) {
          const message = "Token refresh failed: response missing accessToken or refreshToken.";
          recordAuthFailure({ stage: "refresh", message, code: "malformed_refresh_response" });
          throw new CloudAuthError(message);
        }

        const expiresAt = resolveExpiresAt(tokenData);
        this.credentials = {
          ...this.credentials,
          accessToken,
          refreshToken,
          clientId: readString(tokenData.clientId) ?? this.credentials.clientId,
          expiresAt,
          lastAuthFailure: undefined,
        };

        saveCredentials(this.credentials);
      } catch (error) {
        if (error instanceof CloudAuthError) throw error;
        const message = `Token refresh failed: ${error instanceof Error ? error.message : String(error)}`;
        recordAuthFailure({ stage: "refresh", message });
        throw new CloudAuthError(message);
      }
    });
  }

  private sameServer(serverUrl: string): boolean {
    return serverUrl.replace(/\/$/, "") === this.serverUrl;
  }

  private recordRequestAuthFailure(status: number, statusText: string, code?: string): void {
    recordAuthFailure({
      stage: "request",
      message: `Authentication failed: ${status} ${statusText}`,
      status,
      code,
    });
  }
}

function resolveExpiresAt(data: TokenRefreshResponse): string {
  const explicit = readString(data.expiresAt);
  if (explicit) {
    const timestamp = new Date(explicit).getTime();
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }

  const expiresIn = typeof data.expiresIn === "number" ? data.expiresIn : Number(data.expiresIn);
  if (Number.isFinite(expiresIn) && expiresIn > 0) {
    return new Date(Date.now() + expiresIn * 1000).toISOString();
  }

  const message = "Token refresh failed: response missing valid expiresAt or expiresIn.";
  recordAuthFailure({ stage: "refresh", message, code: "malformed_refresh_response" });
  throw new CloudAuthError(message);
}

async function readResponseBody(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  } catch {
    return null;
  }
}

function readBodyCode(body: unknown): string | undefined {
  const record = asRecord(body);
  return readString(record.code) ?? readString(record.reason) ?? readString(record.error);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRefreshTokenStatusClient(value: unknown): RefreshTokenStatus["client"] {
  const record = asRecord(value);
  const id = readString(record.id);
  const displayName = readString(record.displayName);
  if (!id || !displayName) return undefined;
  return {
    id,
    displayName,
    platform: readString(record.platform) ?? null,
    isActive: record.isActive === true,
    lastSeenAt: readString(record.lastSeenAt) ?? null,
  };
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
