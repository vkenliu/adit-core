import { describe, it, expect, afterEach } from "vitest";
import { loadCloudConfig } from "./config.js";

describe("loadCloudConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("ADIT_CLOUD_")) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it("returns defaults when no env vars are set", () => {
    delete process.env.ADIT_CLOUD_URL;
    delete process.env.ADIT_CLOUD_ENABLED;
    delete process.env.ADIT_CLOUD_AUTO_SYNC;
    delete process.env.ADIT_CLOUD_BATCH_SIZE;
    delete process.env.ADIT_CLOUD_SYNC_THRESHOLD;
    delete process.env.ADIT_CLOUD_SYNC_TIMEOUT_HOURS;

    const config = loadCloudConfig();
    expect(config.serverUrl).toBeNull();
    expect(config.enabled).toBe(false);
    expect(config.autoSync).toBe(false);
    expect(config.batchSize).toBe(500);
    expect(config.syncThreshold).toBe(50);
    expect(config.syncTimeoutHours).toBe(12);
  });

  it("reads syncThreshold from ADIT_CLOUD_SYNC_THRESHOLD", () => {
    process.env.ADIT_CLOUD_SYNC_THRESHOLD = "100";
    const config = loadCloudConfig();
    expect(config.syncThreshold).toBe(100);
  });

  it("enforces minimum syncThreshold of 1", () => {
    process.env.ADIT_CLOUD_SYNC_THRESHOLD = "0";
    const config = loadCloudConfig();
    expect(config.syncThreshold).toBe(1);
  });

  it("falls back to 50 for invalid syncThreshold", () => {
    process.env.ADIT_CLOUD_SYNC_THRESHOLD = "not-a-number";
    const config = loadCloudConfig();
    expect(config.syncThreshold).toBe(50);
  });

  it("enables cloud when server URL is set", () => {
    process.env.ADIT_CLOUD_URL = "https://cloud.example.com";
    const config = loadCloudConfig();
    expect(config.serverUrl).toBe("https://cloud.example.com");
    expect(config.enabled).toBe(true);
  });

  it("caps batchSize at 500", () => {
    process.env.ADIT_CLOUD_BATCH_SIZE = "1000";
    const config = loadCloudConfig();
    expect(config.batchSize).toBe(500);
  });

  it("reads syncTimeoutHours from ADIT_CLOUD_SYNC_TIMEOUT_HOURS", () => {
    process.env.ADIT_CLOUD_SYNC_TIMEOUT_HOURS = "6";
    const config = loadCloudConfig();
    expect(config.syncTimeoutHours).toBe(6);
  });

  it("supports fractional syncTimeoutHours", () => {
    process.env.ADIT_CLOUD_SYNC_TIMEOUT_HOURS = "0.5";
    const config = loadCloudConfig();
    expect(config.syncTimeoutHours).toBe(0.5);
  });

  it("falls back to 12 for invalid syncTimeoutHours", () => {
    process.env.ADIT_CLOUD_SYNC_TIMEOUT_HOURS = "not-a-number";
    const config = loadCloudConfig();
    expect(config.syncTimeoutHours).toBe(12);
  });

  it("falls back to 12 for non-positive syncTimeoutHours", () => {
    process.env.ADIT_CLOUD_SYNC_TIMEOUT_HOURS = "0";
    const config = loadCloudConfig();
    expect(config.syncTimeoutHours).toBe(12);
  });
});
