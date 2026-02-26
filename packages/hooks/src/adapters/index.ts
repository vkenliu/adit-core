export type {
  PlatformAdapter,
  HookMapping,
  NormalizedHookInput,
  PlatformHookConfig,
  ValidationResult,
  ValidationCheck,
  AditHookType,
} from "./types.js";

export { claudeCodeAdapter } from "./claude-code.js";
export { getAdapter, listAdapters, registerAdapter, detectPlatform } from "./registry.js";
