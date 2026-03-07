/**
 * Content-aware secret redaction.
 *
 * Scans text content for secrets using two complementary techniques:
 * 1. Shannon entropy scoring — flags high-entropy strings that look like
 *    randomly generated secrets (API keys, tokens, passwords).
 * 2. Pattern matching — regex-based detection of known secret formats
 *    (AWS keys, GitHub tokens, JWTs, private keys, etc.).
 *
 * Inspired by gitleaks/trufflehog approaches. Designed to run on transcript
 * data (prompts, responses, tool I/O) before writing to the database.
 */

/** Result of scanning a single string for secrets */
export interface RedactionResult {
  /** The redacted text with secrets replaced */
  redacted: string;
  /** Number of secrets found and replaced */
  secretsFound: number;
  /** Details of each detection for logging/debugging */
  detections: SecretDetection[];
}

export interface SecretDetection {
  /** What triggered the detection */
  method: "entropy" | "pattern";
  /** Name of the matched pattern (if pattern-based) */
  patternName?: string;
  /** Character offset in the original string */
  offset: number;
  /** Length of the matched secret */
  length: number;
}

/** Configuration for the content redaction pipeline */
export interface RedactionConfig {
  /** Shannon entropy threshold (default: 4.5) */
  entropyThreshold?: number;
  /** Minimum token length to check for entropy (default: 8) */
  minTokenLength?: number;
  /** Maximum token length to check for entropy (default: 256) */
  maxTokenLength?: number;
  /** Replacement string for detected secrets (default: "[REDACTED]") */
  replacement?: string;
  /** Additional custom patterns to match */
  customPatterns?: SecretPattern[];
  /** Field names to skip scanning (e.g., "id", "signature") */
  skipFields?: string[];
}

export interface SecretPattern {
  /** Human-readable name for this pattern */
  name: string;
  /** Regex to match the secret */
  pattern: RegExp;
}

/**
 * Built-in secret patterns based on common formats.
 * Covers major cloud providers, VCS platforms, payment processors,
 * communication tools, and generic credential formats.
 */
export const builtinPatterns: SecretPattern[] = [
  // AWS
  { name: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "aws-secret-key", pattern: /\b[A-Za-z0-9/+=]{40}\b(?=.*aws|.*secret)/i },

  // GitHub
  { name: "github-pat-fine", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,82}\b/ },
  { name: "github-pat", pattern: /\bghp_[A-Za-z0-9]{36,}\b/ },
  { name: "github-oauth", pattern: /\bgho_[A-Za-z0-9]{36,}\b/ },
  { name: "github-app-token", pattern: /\bghu_[A-Za-z0-9]{36,}\b/ },
  { name: "github-refresh-token", pattern: /\bghr_[A-Za-z0-9]{36,}\b/ },

  // GitLab
  { name: "gitlab-pat", pattern: /\bglpat-[A-Za-z0-9\-_]{20,}\b/ },
  { name: "gitlab-pipeline-token", pattern: /\bglptt-[A-Za-z0-9\-_]{20,}\b/ },
  { name: "gitlab-runner-token", pattern: /\bGR1348941[A-Za-z0-9\-_]{20,}\b/ },

  // GCP / Google
  { name: "gcp-api-key", pattern: /\bAIza[0-9A-Za-z\-_]{35}\b/ },
  { name: "gcp-service-account", pattern: /"type"\s*:\s*"service_account"/ },

  // Azure
  { name: "azure-storage-key", pattern: /\b[A-Za-z0-9+/]{86}==\b/ },

  // Stripe
  { name: "stripe-secret-key", pattern: /\bsk_live_[A-Za-z0-9]{24,}\b/ },
  { name: "stripe-publishable", pattern: /\bpk_live_[A-Za-z0-9]{24,}\b/ },
  { name: "stripe-restricted", pattern: /\brk_live_[A-Za-z0-9]{24,}\b/ },

  // Slack
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9\-]{10,}\b/ },
  { name: "slack-webhook", pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/ },

  // Discord
  { name: "discord-token", pattern: /\b[MN][A-Za-z0-9]{23,}\.[A-Za-z0-9\-_]{6}\.[A-Za-z0-9\-_]{27,}\b/ },
  { name: "discord-webhook", pattern: /https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9\-_]+/ },

  // Twilio
  { name: "twilio-api-key", pattern: /\bSK[0-9a-fA-F]{32}\b/ },

  // SendGrid
  { name: "sendgrid-api-key", pattern: /\bSG\.[A-Za-z0-9\-_]{22,}\.[A-Za-z0-9\-_]{22,}\b/ },

  // npm
  { name: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36,}\b/ },

  // PyPI
  { name: "pypi-token", pattern: /\bpypi-[A-Za-z0-9\-_]{16,}\b/ },

  // Heroku
  { name: "heroku-api-key", pattern: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/ },

  // Private keys
  { name: "private-key-rsa", pattern: /-----BEGIN RSA PRIVATE KEY-----/ },
  { name: "private-key-dsa", pattern: /-----BEGIN DSA PRIVATE KEY-----/ },
  { name: "private-key-ec", pattern: /-----BEGIN EC PRIVATE KEY-----/ },
  { name: "private-key-openssh", pattern: /-----BEGIN OPENSSH PRIVATE KEY-----/ },
  { name: "private-key-pgp", pattern: /-----BEGIN PGP PRIVATE KEY BLOCK-----/ },
  { name: "private-key-generic", pattern: /-----BEGIN PRIVATE KEY-----/ },

  // Generic credential patterns
  { name: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9\-_\.]{20,}\b/ },
  { name: "basic-auth", pattern: /\bBasic\s+[A-Za-z0-9+/=]{20,}\b/ },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\b/ },

  // Database connection strings
  { name: "postgres-uri", pattern: /postgres(?:ql)?:\/\/[^\s'"]+:[^\s'"]+@[^\s'"]+/ },
  { name: "mysql-uri", pattern: /mysql:\/\/[^\s'"]+:[^\s'"]+@[^\s'"]+/ },
  { name: "mongodb-uri", pattern: /mongodb(?:\+srv)?:\/\/[^\s'"]+:[^\s'"]+@[^\s'"]+/ },
  { name: "redis-uri", pattern: /redis(?:s)?:\/\/[^\s'"]+:[^\s'"]+@[^\s'"]+/ },

  // Generic password/secret in assignments
  { name: "password-assignment", pattern: /(?:password|passwd|pwd)\s*[:=]\s*["'][^"']{8,}["']/i },
  { name: "secret-assignment", pattern: /(?:secret|api_?key|access_?key|auth_?token)\s*[:=]\s*["'][^"']{8,}["']/i },
];

/**
 * Default field names to skip when scanning structured data.
 * These commonly contain high-entropy but non-secret data.
 */
export const defaultSkipFields = [
  "id",
  "ids",
  "signature",
  "hash",
  "sha",
  "checksum",
  "digest",
  "uuid",
  "ulid",
];

/**
 * Compute Shannon entropy for a string.
 *
 * Shannon entropy measures the randomness/information density of a string.
 * Random strings (like API keys) typically have entropy > 4.5 bits per character,
 * while natural language text is usually below 4.0.
 *
 * @param s - The string to analyze
 * @returns Entropy in bits per character (0 to log2(charset_size))
 */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;

  const freq = new Map<string, number>();
  for (const ch of s) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }

  let entropy = 0;
  const len = s.length;
  for (const count of freq.values()) {
    const p = count / len;
    if (p > 0) {
      entropy -= p * Math.log2(p);
    }
  }
  return entropy;
}

/**
 * Extract candidate tokens from text that might be secrets.
 *
 * Tokens are contiguous sequences of non-whitespace characters that
 * meet minimum length requirements. We split on whitespace and common
 * delimiters to isolate individual tokens.
 */
function extractTokens(
  text: string,
  minLength: number,
  maxLength: number,
): Array<{ token: string; offset: number }> {
  const results: Array<{ token: string; offset: number }> = [];
  // Match contiguous non-whitespace tokens
  const tokenRegex = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(text)) !== null) {
    const raw = match[0];
    const offset = match.index;

    // Strip common surrounding quotes/brackets
    let token = raw;
    let tokenOffset = offset;
    if (/^["'`({[]/.test(token)) {
      token = token.slice(1);
      tokenOffset += 1;
    }
    if (/["'`)};\],.]$/.test(token)) {
      token = token.slice(0, -1);
    }

    if (token.length >= minLength && token.length <= maxLength) {
      results.push({ token, offset: tokenOffset });
    }
  }
  return results;
}

/**
 * Scan text for secrets using entropy-based detection.
 *
 * Extracts tokens and checks each for high Shannon entropy,
 * which indicates randomly generated strings like API keys.
 */
function scanEntropy(
  text: string,
  threshold: number,
  minTokenLength: number,
  maxTokenLength: number,
): SecretDetection[] {
  const detections: SecretDetection[] = [];
  const tokens = extractTokens(text, minTokenLength, maxTokenLength);

  for (const { token, offset } of tokens) {
    // Skip tokens that look like file paths, URLs, or common code patterns
    if (looksLikeNonSecret(token)) continue;

    const entropy = shannonEntropy(token);
    if (entropy >= threshold) {
      detections.push({
        method: "entropy",
        offset,
        length: token.length,
      });
    }
  }

  return detections;
}

/**
 * Check if a token looks like a non-secret high-entropy string.
 * Helps reduce false positives from file paths, import statements, etc.
 */
function looksLikeNonSecret(token: string): boolean {
  // File paths
  if (token.startsWith("/") || token.startsWith("./") || token.startsWith("../")) return true;
  if (token.includes("/src/") || token.includes("/node_modules/")) return true;

  // URLs without credentials
  if (/^https?:\/\/[^:@]*$/.test(token)) return true;

  // Package names and imports
  if (token.startsWith("@") && token.includes("/")) return true;

  // Common code patterns (hex colors, version numbers, etc.)
  if (/^#[0-9a-fA-F]{3,8}$/.test(token)) return true;
  if (/^\d+\.\d+\.\d+/.test(token)) return true;

  // Base64-encoded image data markers
  if (token.startsWith("data:image/")) return true;

  return false;
}

/**
 * Scan text for secrets using pattern matching.
 */
function scanPatterns(
  text: string,
  patterns: SecretPattern[],
): SecretDetection[] {
  const detections: SecretDetection[] = [];

  for (const { name, pattern } of patterns) {
    // Create a global version of the pattern for scanning
    const globalPattern = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    let match: RegExpExecArray | null;
    while ((match = globalPattern.exec(text)) !== null) {
      detections.push({
        method: "pattern",
        patternName: name,
        offset: match.index,
        length: match[0].length,
      });
    }
  }

  return detections;
}

/**
 * Merge overlapping detection ranges and sort by offset.
 * When both entropy and pattern detection flag the same region,
 * we keep the pattern-based detection (more specific).
 */
function mergeDetections(detections: SecretDetection[]): SecretDetection[] {
  if (detections.length <= 1) return detections;

  // Sort by offset
  const sorted = [...detections].sort((a, b) => a.offset - b.offset);
  const merged: SecretDetection[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = sorted[i];

    // Check overlap
    if (curr.offset <= prev.offset + prev.length) {
      // Overlapping — keep the one that covers more or prefer pattern-based
      if (curr.method === "pattern" && prev.method === "entropy") {
        // Replace entropy detection with pattern detection
        merged[merged.length - 1] = {
          method: curr.method,
          patternName: curr.patternName,
          offset: Math.min(prev.offset, curr.offset),
          length: Math.max(prev.offset + prev.length, curr.offset + curr.length) - Math.min(prev.offset, curr.offset),
        };
      } else {
        // Extend the previous detection
        const newEnd = Math.max(prev.offset + prev.length, curr.offset + curr.length);
        merged[merged.length - 1] = {
          ...prev,
          length: newEnd - prev.offset,
        };
      }
    } else {
      merged.push(curr);
    }
  }

  return merged;
}

/**
 * Redact secrets from a text string.
 *
 * Combines entropy-based and pattern-based scanning to detect
 * and replace secrets with a configurable placeholder.
 *
 * @param text - The text to scan and redact
 * @param config - Optional configuration overrides
 * @returns The redacted text and detection details
 */
export function redactContent(
  text: string,
  config: RedactionConfig = {},
): RedactionResult {
  const {
    entropyThreshold = 4.5,
    minTokenLength = 8,
    maxTokenLength = 256,
    replacement = "[REDACTED]",
    customPatterns = [],
  } = config;

  if (!text || text.length === 0) {
    return { redacted: text, secretsFound: 0, detections: [] };
  }

  // Run both detection methods
  const entropyDetections = scanEntropy(text, entropyThreshold, minTokenLength, maxTokenLength);
  const allPatterns = [...builtinPatterns, ...customPatterns];
  const patternDetections = scanPatterns(text, allPatterns);

  // Merge and deduplicate
  const allDetections = mergeDetections([...entropyDetections, ...patternDetections]);

  if (allDetections.length === 0) {
    return { redacted: text, secretsFound: 0, detections: [] };
  }

  // Apply replacements from end to start to preserve offsets
  let redacted = text;
  for (let i = allDetections.length - 1; i >= 0; i--) {
    const det = allDetections[i];
    redacted =
      redacted.substring(0, det.offset) +
      replacement +
      redacted.substring(det.offset + det.length);
  }

  return {
    redacted,
    secretsFound: allDetections.length,
    detections: allDetections,
  };
}

/**
 * Check if a field name should be skipped during structured data scanning.
 *
 * Fields like "id", "signature", "hash" etc. often contain high-entropy
 * strings that are not secrets.
 */
export function shouldSkipField(
  fieldName: string,
  skipFields?: string[],
): boolean {
  const fields = skipFields ?? defaultSkipFields;
  const lower = fieldName.toLowerCase();

  for (const skip of fields) {
    const skipLower = skip.toLowerCase();
    if (lower === skipLower) return true;
    if (lower.endsWith(skipLower)) return true;
  }

  // Skip fields whose values are image/base64 data
  if (lower === "type" || lower === "content_type") return true;

  return false;
}

/**
 * Recursively redact secrets from a structured object.
 *
 * Walks through all string values in the object tree and applies
 * content-aware redaction. Skips fields that commonly contain
 * non-secret high-entropy data (IDs, signatures, hashes).
 *
 * @param obj - The object to scan
 * @param config - Optional redaction configuration
 * @returns A new object with secrets redacted
 */
export function redactObject(
  obj: unknown,
  config: RedactionConfig = {},
): unknown {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === "string") {
    return redactContent(obj, config).redacted;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redactObject(item, config));
  }

  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    const skipFields = config.skipFields ?? defaultSkipFields;

    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (shouldSkipField(key, skipFields)) {
        result[key] = value;
      } else if (typeof value === "string") {
        // Check if this is an image/base64 value
        if (typeof value === "string" && (value.startsWith("data:image/") || value.startsWith("base64,"))) {
          result[key] = value;
        } else {
          result[key] = redactContent(value, config).redacted;
        }
      } else {
        result[key] = redactObject(value, config);
      }
    }
    return result;
  }

  return obj;
}
