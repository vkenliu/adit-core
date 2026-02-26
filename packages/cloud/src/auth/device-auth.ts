/**
 * Device authorization flow.
 *
 * Implements the device code flow (similar to GitHub CLI / VS Code):
 * 1. Client requests a device code + user code
 * 2. User opens a browser, enters the user code, and approves
 * 3. Client polls until approved, then receives tokens
 */

import { CloudApiError, CloudNetworkError } from "../http/errors.js";

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  expiresAt: string;
}

export interface DeviceAuthOptions {
  /** Machine identifier (hardware fingerprint) */
  machineId: string;
  /** Platform (e.g., "darwin-arm64") */
  platform: string;
  /** ADIT version */
  aditVersion: string;
  /** Display name for the device (e.g., "MacBook Pro Work") */
  displayName?: string;
}

/** Step 1: Request a device code from the server */
export async function requestDeviceCode(
  serverUrl: string,
  options: DeviceAuthOptions,
): Promise<DeviceCodeResponse> {
  const url = `${serverUrl.replace(/\/$/, "")}/api/auth/device`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        machineId: options.machineId,
        platform: options.platform,
        aditVersion: options.aditVersion,
        displayName: options.displayName,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new CloudApiError(
        `Failed to request device code: ${response.status}`,
        response.status,
        body,
      );
    }

    return (await response.json()) as DeviceCodeResponse;
  } catch (error) {
    if (error instanceof CloudApiError) throw error;
    throw new CloudNetworkError(
      `Failed to connect to ${serverUrl}: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error : undefined,
    );
  }
}

/**
 * Step 2: Poll for token approval.
 *
 * Polls the server every `intervalMs` until the user approves
 * the device or the request expires/times out.
 */
export async function pollForToken(
  serverUrl: string,
  deviceCode: string,
  intervalMs = 5000,
  timeoutMs = 300_000, // 5 minutes
): Promise<TokenResponse> {
  const url = `${serverUrl.replace(/\/$/, "")}/api/auth/device/token`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceCode }),
      });

      if (response.ok) {
        return (await response.json()) as TokenResponse;
      }

      // 428 = authorization_pending (standard device flow response)
      if (response.status === 428) {
        await sleep(intervalMs);
        continue;
      }

      // 410 = expired
      if (response.status === 410) {
        throw new CloudApiError(
          "Device authorization request expired. Please try again.",
          410,
        );
      }

      // 409 = denied
      if (response.status === 409) {
        throw new CloudApiError(
          "Device authorization was denied by the user.",
          409,
        );
      }

      // Other errors
      const body = await response.text();
      throw new CloudApiError(
        `Unexpected response during device polling: ${response.status}`,
        response.status,
        body,
      );
    } catch (error) {
      if (error instanceof CloudApiError) throw error;
      // Network errors during polling — wait and retry
      await sleep(intervalMs);
    }
  }

  throw new CloudApiError(
    "Device authorization timed out. Please try again.",
    408,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
