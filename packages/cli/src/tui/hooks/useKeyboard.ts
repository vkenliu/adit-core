/**
 * Keyboard shortcut handler for TUI.
 *
 * Maps key presses to TUI actions.
 */

import { useInput } from "ink";

export type Screen = "timeline" | "diff" | "search" | "env" | "help";

export interface KeyboardActions {
  onNavigateUp: () => void;
  onNavigateDown: () => void;
  onSelect: () => void;
  onShowDiff: () => void;
  onShowPrompt: () => void;
  onShowEnv: () => void;
  onSearch: () => void;
  onFilter: () => void;
  onSort: () => void;
  onLabel: () => void;
  onHelp: () => void;
  onBack: () => void;
  onQuit: () => void;
}

export function useKeyboard(actions: KeyboardActions, enabled = true): void {
  useInput(
    (input, key) => {
      if (!enabled) return;

      // Navigation
      if (input === "j" || key.downArrow) {
        actions.onNavigateDown();
        return;
      }
      if (input === "k" || key.upArrow) {
        actions.onNavigateUp();
        return;
      }
      if (key.return) {
        actions.onSelect();
        return;
      }

      // Screen switches
      if (input === "d") {
        actions.onShowDiff();
        return;
      }
      if (input === "p") {
        actions.onShowPrompt();
        return;
      }
      if (input === "e") {
        actions.onShowEnv();
        return;
      }
      if (input === "/") {
        actions.onSearch();
        return;
      }
      if (input === "f") {
        actions.onFilter();
        return;
      }
      if (input === "s") {
        actions.onSort();
        return;
      }
      if (input === "l") {
        actions.onLabel();
        return;
      }
      if (input === "?") {
        actions.onHelp();
        return;
      }

      // Back / quit
      if (key.escape || input === "b") {
        actions.onBack();
        return;
      }
      if (input === "q") {
        actions.onQuit();
        return;
      }
    },
    { isActive: enabled },
  );
}
