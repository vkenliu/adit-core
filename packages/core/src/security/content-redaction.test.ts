/**
 * Tests for content-aware secret redaction.
 */

import { describe, it, expect } from "vitest";
import {
  shannonEntropy,
  redactContent,
  redactObject,
  shouldSkipField,
  builtinPatterns,
} from "./content-redaction.js";

describe("Content-Aware Secret Redaction", () => {
  describe("shannonEntropy", () => {
    it("returns 0 for empty string", () => {
      expect(shannonEntropy("")).toBe(0);
    });

    it("returns 0 for single repeated character", () => {
      expect(shannonEntropy("aaaaaaa")).toBe(0);
    });

    it("returns low entropy for simple text", () => {
      const entropy = shannonEntropy("hello");
      expect(entropy).toBeLessThan(2.5);
    });

    it("returns high entropy for random-looking strings", () => {
      // Simulated API key
      const entropy = shannonEntropy("aK9x2mP4qR7wZ3nL5bJ8hF6vT0cY1dU");
      expect(entropy).toBeGreaterThan(4.0);
    });

    it("returns moderate entropy for natural language", () => {
      const entropy = shannonEntropy("the quick brown fox jumps over the lazy dog");
      expect(entropy).toBeGreaterThan(3.0);
      expect(entropy).toBeLessThan(4.5);
    });
  });

  describe("redactContent — pattern matching", () => {
    it("detects GitHub personal access tokens (classic)", () => {
      const text = "Use token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij for auth";
      const result = redactContent(text);
      expect(result.secretsFound).toBeGreaterThanOrEqual(1);
      expect(result.redacted).not.toContain("ghp_");
      expect(result.redacted).toContain("[REDACTED]");
    });

    it("detects GitHub fine-grained tokens", () => {
      const text = "token=github_pat_ABCDEFGHIJKLMNOPQRSTUV_0123456789abcdef0123456789abcdef0123456789ab";
      const result = redactContent(text);
      expect(result.secretsFound).toBeGreaterThanOrEqual(1);
      expect(result.redacted).not.toContain("github_pat_");
    });

    it("detects AWS access keys", () => {
      const text = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";
      const result = redactContent(text);
      expect(result.secretsFound).toBeGreaterThanOrEqual(1);
      expect(result.redacted).not.toContain("AKIAIOSFODNN7EXAMPLE");
    });

    it("detects Stripe secret keys", () => {
      const text = 'const key = "sk_test_51HabcdefGHIJKLmnopqrstuv";';
      const result = redactContent(text);
      expect(result.secretsFound).toBeGreaterThanOrEqual(1);
      expect(result.redacted).not.toContain("sk_test_");
    });

    it("detects Slack tokens", () => {
      const text = "SLACK_TOKEN=xoxb-1234567890-abcdefghij";
      const result = redactContent(text);
      expect(result.secretsFound).toBeGreaterThanOrEqual(1);
      expect(result.redacted).not.toContain("xoxb-");
    });

    it("detects private key headers", () => {
      const text = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAK...";
      const result = redactContent(text);
      expect(result.secretsFound).toBeGreaterThanOrEqual(1);
      expect(result.redacted).toContain("[REDACTED]");
    });

    it("detects JWTs", () => {
      const text = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMSJ9.abc123def456ghi789jkl012mno";
      const result = redactContent(text);
      expect(result.secretsFound).toBeGreaterThanOrEqual(1);
      expect(result.redacted).toContain("[REDACTED]");
    });

    it("detects database connection strings", () => {
      const text = 'DATABASE_URL=postgres://admin:s3cretPass@db.example.com:5432/mydb';
      const result = redactContent(text);
      expect(result.secretsFound).toBeGreaterThanOrEqual(1);
      expect(result.redacted).not.toContain("s3cretPass");
    });

    it("detects npm tokens", () => {
      const text = "NPM_TOKEN=npm_abcdefghijklmnopqrstuvwxyz0123456789";
      const result = redactContent(text);
      expect(result.secretsFound).toBeGreaterThanOrEqual(1);
      expect(result.redacted).not.toContain("npm_abcdef");
    });

    it("detects SendGrid API keys", () => {
      const text = "SENDGRID_API_KEY=SG.abcdefghijklmnopqrstuv.wxyz0123456789abcdefghij";
      const result = redactContent(text);
      expect(result.secretsFound).toBeGreaterThanOrEqual(1);
      expect(result.redacted).not.toContain("SG.");
    });

    it("detects password assignments", () => {
      const text = 'password: "mySuperSecretPassword123"';
      const result = redactContent(text);
      expect(result.secretsFound).toBeGreaterThanOrEqual(1);
      expect(result.redacted).toContain("[REDACTED]");
    });
  });

  describe("redactContent — entropy scoring", () => {
    it("redacts high-entropy tokens that look like secrets", () => {
      // This token has high entropy but does not match any specific pattern
      const text = "Use key aK9x2mP4qR7wZ3nL5bJ8hF6vT0cY1dU for access";
      const result = redactContent(text);
      expect(result.secretsFound).toBeGreaterThanOrEqual(1);
      expect(result.redacted).toContain("[REDACTED]");
    });

    it("does not redact normal English text", () => {
      const text = "The quick brown fox jumps over the lazy dog";
      const result = redactContent(text);
      expect(result.secretsFound).toBe(0);
      expect(result.redacted).toBe(text);
    });

    it("does not redact file paths", () => {
      const text = "Edit the file /src/components/UserProfile.tsx to fix the bug";
      const result = redactContent(text);
      expect(result.redacted).toContain("/src/components/UserProfile.tsx");
    });

    it("does not redact URLs without credentials", () => {
      const text = "Visit https://api.example.com/v2/users for the docs";
      const result = redactContent(text);
      expect(result.redacted).toContain("https://api.example.com/v2/users");
    });

    it("does not redact short tokens", () => {
      const text = "Use id abc123 for lookup";
      const result = redactContent(text);
      expect(result.redacted).toBe(text);
    });

    it("does not redact package names", () => {
      const text = "Install @adit/core and @adit/engine packages";
      const result = redactContent(text);
      expect(result.redacted).toContain("@adit/core");
      expect(result.redacted).toContain("@adit/engine");
    });

    it("does not redact hex color codes", () => {
      const text = "Set the color to #FF5733 or #abc";
      const result = redactContent(text);
      expect(result.redacted).toContain("#FF5733");
    });
  });

  describe("redactContent — configuration", () => {
    it("respects custom entropy threshold", () => {
      const text = "token: aK9x2mP4qR7wZ3nL";
      // High threshold should allow the token through
      const relaxed = redactContent(text, { entropyThreshold: 6.0 });
      expect(relaxed.secretsFound).toBe(0);
    });

    it("uses custom replacement string", () => {
      const text = "key=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
      const result = redactContent(text, { replacement: "***REMOVED***" });
      expect(result.redacted).toContain("***REMOVED***");
      expect(result.redacted).not.toContain("[REDACTED]");
    });

    it("applies custom patterns", () => {
      const text = "My internal key is MYAPP_KEY_abcdef123456";
      const result = redactContent(text, {
        customPatterns: [
          { name: "myapp-key", pattern: /MYAPP_KEY_[a-z0-9]{12}/ },
        ],
      });
      expect(result.secretsFound).toBeGreaterThanOrEqual(1);
      expect(result.redacted).not.toContain("MYAPP_KEY_");
    });

    it("returns empty result for empty string", () => {
      const result = redactContent("");
      expect(result.secretsFound).toBe(0);
      expect(result.redacted).toBe("");
    });
  });

  describe("shouldSkipField", () => {
    it("skips id fields", () => {
      expect(shouldSkipField("id")).toBe(true);
      expect(shouldSkipField("sessionId")).toBe(true);
      expect(shouldSkipField("userId")).toBe(true);
    });

    it("skips hash/sha fields", () => {
      expect(shouldSkipField("hash")).toBe(true);
      expect(shouldSkipField("sha")).toBe(true);
      expect(shouldSkipField("checksum")).toBe(true);
      expect(shouldSkipField("commitSha")).toBe(true);
    });

    it("skips signature fields", () => {
      expect(shouldSkipField("signature")).toBe(true);
    });

    it("does not skip normal fields", () => {
      expect(shouldSkipField("prompt")).toBe(false);
      expect(shouldSkipField("response")).toBe(false);
      expect(shouldSkipField("toolOutput")).toBe(false);
    });

    it("respects custom skip list", () => {
      expect(shouldSkipField("myField", ["myField"])).toBe(true);
      expect(shouldSkipField("otherField", ["myField"])).toBe(false);
    });
  });

  describe("redactObject", () => {
    it("redacts secrets in string values", () => {
      const obj = {
        prompt: "My API key is ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
        response: "OK, I will use that key",
      };
      const result = redactObject(obj) as Record<string, string>;
      expect(result.prompt).toContain("[REDACTED]");
      expect(result.prompt).not.toContain("ghp_");
      expect(result.response).toBe("OK, I will use that key");
    });

    it("skips id fields", () => {
      const obj = {
        id: "01HXK9ABCDEFGHIJKLMNOP",
        sessionId: "01HXK9QRSTUVWXYZ012345",
        prompt: "hello",
      };
      const result = redactObject(obj) as Record<string, string>;
      expect(result.id).toBe("01HXK9ABCDEFGHIJKLMNOP");
      expect(result.sessionId).toBe("01HXK9QRSTUVWXYZ012345");
    });

    it("handles nested objects", () => {
      const obj = {
        tool: {
          name: "bash",
          output: "export API_KEY=sk_test_51HabcdefGHIJKLmnopqrstuv",
        },
      };
      const result = redactObject(obj) as Record<string, Record<string, string>>;
      expect(result.tool.output).toContain("[REDACTED]");
      expect(result.tool.name).toBe("bash");
    });

    it("handles arrays", () => {
      const obj = {
        tokens: ["ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij", "normal-text"],
      };
      const result = redactObject(obj) as Record<string, string[]>;
      expect(result.tokens[0]).toContain("[REDACTED]");
      expect(result.tokens[1]).toBe("normal-text");
    });

    it("returns null/undefined unchanged", () => {
      expect(redactObject(null)).toBeNull();
      expect(redactObject(undefined)).toBeUndefined();
    });

    it("returns numbers and booleans unchanged", () => {
      expect(redactObject(42)).toBe(42);
      expect(redactObject(true)).toBe(true);
    });

    it("skips base64 image data", () => {
      const obj = {
        image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB...",
        caption: "A photo",
      };
      const result = redactObject(obj) as Record<string, string>;
      expect(result.image).toContain("data:image/png");
      expect(result.caption).toBe("A photo");
    });
  });

  describe("builtinPatterns", () => {
    it("has patterns for major providers", () => {
      const names = builtinPatterns.map((p) => p.name);
      expect(names).toContain("aws-access-key");
      expect(names).toContain("github-pat");
      expect(names).toContain("stripe-secret-key");
      expect(names).toContain("slack-token");
      expect(names).toContain("jwt");
      expect(names).toContain("private-key-rsa");
      expect(names).toContain("postgres-uri");
    });

    it("all patterns are valid regexes", () => {
      for (const { name, pattern } of builtinPatterns) {
        expect(() => new RegExp(pattern.source, "g"), `Pattern "${name}" should be valid`).not.toThrow();
      }
    });
  });
});
