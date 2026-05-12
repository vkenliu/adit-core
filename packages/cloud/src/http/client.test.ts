import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { existsSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const tempHome = join(tmpdir(), `adit-client-test-${randomBytes(8).toString("hex")}`);

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => tempHome,
  };
});

import { CloudClient } from "./client.js";
import { CloudAuthError } from "./errors.js";
import { loadCredentials, saveCredentials, type CloudCredentials } from "../auth/credentials.js";

function makeCreds(overrides: Partial<CloudCredentials> = {}): CloudCredentials {
  return {
    authType: "device",
    accessToken: "old-access",
    refreshToken: "old-refresh",
    clientId: "client-1",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    serverUrl: "http://cloud.test",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { "Content-Type": "application/json" },
  });
}

describe("CloudClient token refresh", () => {
  beforeEach(() => {
    mkdirSync(join(tempHome, ".adit"), { recursive: true });
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    try {
      const path = join(tempHome, ".adit", "cloud-credentials.json");
      if (existsSync(path)) unlinkSync(path);
      rmSync(join(tempHome, ".adit", "cloud-credentials.refresh.lock"), { force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("computes expiresAt when refresh response only returns expiresIn", async () => {
    const before = Date.now();
    const credentials = makeCreds();
    saveCredentials(credentials);

    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        accessToken: "new-access",
        refreshToken: "new-refresh",
        clientId: "client-1",
        expiresIn: 3600,
      }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const client = new CloudClient("http://cloud.test", credentials);
    await client.get("/api/test");

    const saved = loadCredentials();
    expect(saved?.accessToken).toBe("new-access");
    expect(saved?.refreshToken).toBe("new-refresh");
    expect(new Date(saved!.expiresAt).getTime()).toBeGreaterThanOrEqual(before + 3_590_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("records auth failure when refresh response lacks expiry metadata", async () => {
    const credentials = makeCreds();
    saveCredentials(credentials);

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({
      accessToken: "new-access",
      refreshToken: "new-refresh",
    }));

    const client = new CloudClient("http://cloud.test", credentials);
    await expect(client.get("/api/test")).rejects.toBeInstanceOf(CloudAuthError);

    const saved = loadCredentials();
    expect(saved?.lastAuthFailure?.stage).toBe("refresh");
    expect(saved?.lastAuthFailure?.code).toBe("malformed_refresh_response");
  });

  it("reuses credentials refreshed by another process instead of rotating twice", async () => {
    const original = makeCreds();
    const alreadyRefreshed = makeCreds({
      accessToken: "fresh-access",
      refreshToken: "fresh-refresh",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    saveCredentials(alreadyRefreshed);

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ ok: true }));

    const client = new CloudClient("http://cloud.test", original);
    await client.get("/api/test");

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(fetch).mock.calls[0];
    expect(String(call[0])).toBe("http://cloud.test/api/test");
    expect((call[1]?.headers as Record<string, string>).Authorization).toBe("Bearer fresh-access");
  });
});
