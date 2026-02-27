/**
 * Chat history parsing and discovery — barrel export.
 */

export {
  parseChatHistoryFile,
  type ChatHistoryMessage,
  type ToolUseInfo,
  type ToolResultInfo,
} from "./parser.js";

export {
  discoverProjects,
  discoverSessions,
  findCurrentProject,
  escapePath,
  type ClaudeProject,
  type ClaudeSession,
} from "./discovery.js";
