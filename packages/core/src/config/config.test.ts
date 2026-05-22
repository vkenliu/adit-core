import { describe, it, expect } from "vitest";
import { projectNameFromRoot, redactSensitiveKeys } from "./index.js";

describe("Config", () => {
  describe("projectNameFromRoot", () => {
    it("extracts project name from POSIX root", () => {
      expect(projectNameFromRoot("/Users/edy/item/adit-core1")).toBe("adit-core1");
    });

    it("extracts project name from Windows root", () => {
      expect(projectNameFromRoot("C:\\Users\\edy\\item\\adit-core1")).toBe("adit-core1");
    });

    it("handles trailing separators", () => {
      expect(projectNameFromRoot("C:\\Users\\edy\\item\\adit-core1\\")).toBe("adit-core1");
      expect(projectNameFromRoot("/Users/edy/item/adit-core1/")).toBe("adit-core1");
    });
  });

  describe("redactSensitiveKeys", () => {
    it("redacts known sensitive keys", () => {
      const input = {
        api_key: "sk-123456",
        name: "test",
        password: "secret123",
      };

      const result = redactSensitiveKeys(input, [
        "api_key",
        "password",
      ]);

      expect(result.api_key).toBe("[REDACTED]");
      expect(result.name).toBe("test");
      expect(result.password).toBe("[REDACTED]");
    });

    it("is case insensitive", () => {
      const input = { API_KEY: "sk-123", Authorization: "Bearer tok" };
      const result = redactSensitiveKeys(input, ["api_key", "authorization"]);

      expect(result.API_KEY).toBe("[REDACTED]");
      expect(result.Authorization).toBe("[REDACTED]");
    });

    it("recursively redacts nested objects", () => {
      const input = {
        headers: {
          authorization: "Bearer token",
          "content-type": "application/json",
        },
        body: "hello",
      };

      const result = redactSensitiveKeys(input, ["authorization"]);
      const headers = result.headers as Record<string, unknown>;

      expect(headers.authorization).toBe("[REDACTED]");
      expect(headers["content-type"]).toBe("application/json");
    });

    it("leaves arrays and primitives intact", () => {
      const input = {
        tags: ["a", "b"],
        count: 42,
        active: true,
      };

      const result = redactSensitiveKeys(input, ["api_key"]);
      expect(result.tags).toEqual(["a", "b"]);
      expect(result.count).toBe(42);
      expect(result.active).toBe(true);
    });
  });
});
