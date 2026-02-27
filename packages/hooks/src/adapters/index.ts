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
export { createStubAdapter, cursorAdapter, copilotAdapter, opencodeAdapter, codexAdapter } from "./stub.js";
export { getAdapter, listAdapters, registerAdapter, detectPlatform } from "./registry.js";
