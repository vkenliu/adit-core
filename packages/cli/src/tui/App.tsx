/**
 * Root TUI application component.
 *
 * Routes between screens and manages global state.
 */

import React, { useState, useCallback, useMemo } from "react";
import { Box, Text, useApp, useStdout } from "ink";
import Spinner from "ink-spinner";
import { useTimeline } from "./hooks/useTimeline.js";
import { useKeyboard, type Screen } from "./hooks/useKeyboard.js";
import { StatusBar } from "./components/StatusBar.js";
import { TimelineScreen } from "./screens/TimelineScreen.js";
import { DiffScreen } from "./screens/DiffScreen.js";
import { SearchScreen } from "./screens/SearchScreen.js";
import { EnvScreen } from "./screens/EnvScreen.js";
import type { EnvSnapshot } from "@adit/core";
import { type SortField, sortEvents } from "../commands/list.js";

export function App(): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 24;

  const [screen, setScreen] = useState<Screen>("timeline");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showFilters, setShowFilters] = useState(false);
  const [envSnapshot, setEnvSnapshot] = useState<EnvSnapshot | null>(null);
  const [sortField, setSortField] = useState<SortField>("TIME");

  const SORT_CYCLE: SortField[] = ["TIME", "ACTOR"];

  const {
    state,
    filters,
    setFilters,
    selectEvent,
    getEventDiff,
    getEnvSnapshot,
  } = useTimeline();

  const events = useMemo(
    () => sortEvents(state.events, sortField),
    [state.events, sortField],
  );

  // Ensure selectedIndex stays in bounds
  const safeIndex = useMemo(
    () => Math.min(selectedIndex, Math.max(0, events.length - 1)),
    [selectedIndex, events.length],
  );

  const selectedEvent = events[safeIndex] ?? null;

  const navigateUp = useCallback(() => {
    setSelectedIndex((i) => Math.max(0, i - 1));
  }, []);

  const navigateDown = useCallback(() => {
    setSelectedIndex((i) => Math.min(events.length - 1, i + 1));
  }, [events.length]);

  const handleSelect = useCallback(() => {
    if (selectedEvent) {
      selectEvent(selectedEvent.id);
    }
  }, [selectedEvent, selectEvent]);

  const handleShowDiff = useCallback(() => {
    if (selectedEvent) {
      selectEvent(selectedEvent.id);
      setScreen("diff");
    }
  }, [selectedEvent, selectEvent]);

  const handleShowEnv = useCallback(() => {
    const snap = getEnvSnapshot();
    setEnvSnapshot(snap);
    setScreen("env");
  }, [getEnvSnapshot]);

  const handleSearch = useCallback(() => {
    setScreen("search");
  }, []);

  const handleFilter = useCallback(() => {
    setShowFilters((v) => !v);
  }, []);

  const handleSort = useCallback(() => {
    setSortField((current) => {
      const idx = SORT_CYCLE.indexOf(current);
      return SORT_CYCLE[(idx + 1) % SORT_CYCLE.length];
    });
  }, []);

  const handleBack = useCallback(() => {
    if (screen !== "timeline") {
      setScreen("timeline");
      // Clear search filter when leaving search
      if (screen === "search") {
        setFilters({});
      }
    }
  }, [screen, setFilters]);

  const handleHelp = useCallback(() => {
    setScreen(screen === "help" ? "timeline" : "help");
  }, [screen]);

  const handleQuit = useCallback(() => {
    exit();
  }, [exit]);

  const handleSearchSubmit = useCallback(
    (query: string) => {
      setFilters({ ...filters, searchQuery: query });
    },
    [filters, setFilters],
  );

  useKeyboard(
    {
      onNavigateUp: navigateUp,
      onNavigateDown: navigateDown,
      onSelect: handleSelect,
      onShowDiff: handleShowDiff,
      onShowPrompt: handleSelect,
      onShowEnv: handleShowEnv,
      onSearch: handleSearch,
      onFilter: handleFilter,
      onSort: handleSort,
      onHelp: handleHelp,
      onBack: handleBack,
      onQuit: handleQuit,
    },
    screen === "timeline" || screen === "diff" || screen === "env" || screen === "help",
  );

  // Header
  const header = (
    <Box
      flexDirection="row"
      justifyContent="space-between"
      width="100%"
      paddingX={1}
    >
      <Text bold color="cyan">
        ADIT — AI Development Intent Tracker
      </Text>
      {state.session?.id && (
        <Text dimColor>
          [{state.session.platform}]{" "}
          {state.session.id.substring(0, 10)}
        </Text>
      )}
    </Box>
  );

  // Loading state
  if (state.loading) {
    return (
      <Box flexDirection="column" width="100%">
        {header}
        <Box paddingX={1}>
          <Spinner type="dots" />
          <Text> Loading timeline...</Text>
        </Box>
      </Box>
    );
  }

  // Error state
  if (state.error) {
    return (
      <Box flexDirection="column" width="100%">
        {header}
        <Box paddingX={1}>
          <Text color="red">Error: {state.error}</Text>
        </Box>
        <Box paddingX={1}>
          <Text dimColor>
            Try running "adit init" first. Press q to quit.
          </Text>
        </Box>
      </Box>
    );
  }

  // Content height = terminal - header (1) - status bar (1) - borders (1)
  const contentHeight = termHeight - 3;

  let content: React.ReactElement;

  switch (screen) {
    case "diff":
      content = (
        <DiffScreen
          event={selectedEvent}
          getDiff={getEventDiff}
        />
      );
      break;

    case "search":
      content = (
        <SearchScreen
          onSearch={handleSearchSubmit}
          events={events}
          selectedIndex={safeIndex}
        />
      );
      break;

    case "env":
      content = <EnvScreen snapshot={envSnapshot} />;
      break;

    case "help":
      content = (
        <Box flexDirection="column" paddingX={1}>
          <Text bold>Keybindings</Text>
          <Text dimColor>{"─".repeat(30)}</Text>
          <Text>j/k or ↑/↓{"   "}Navigate events (detail updates live)</Text>
          <Text>d{"            "}Show diff for checkpoint</Text>
          <Text>p{"            "}Show prompt text</Text>
          <Text>e{"            "}Show environment snapshot</Text>
          <Text>/{"            "}Open search</Text>
          <Text>f{"            "}Toggle filter panel</Text>
          <Text>s{"            "}Cycle sort (TIME→ACTOR)</Text>
          <Text>Esc / b{"      "}Go back</Text>
          <Text>q{"            "}Quit</Text>
          <Text>?{"            "}Toggle this help</Text>
          <Box marginTop={1}>
            <Text dimColor>Press ? or Esc to close</Text>
          </Box>
        </Box>
      );
      break;

    case "timeline":
    default:
      content = (
        <TimelineScreen
          events={events}
          selectedIndex={safeIndex}
          selectedEvent={selectedEvent}
          filters={filters}
          showFilters={showFilters}
          sortField={sortField}
          height={contentHeight}
        />
      );
      break;
  }

  return (
    <Box flexDirection="column" width="100%" height={termHeight}>
      {header}
      <Box flexDirection="column" flexGrow={1}>
        {content}
      </Box>
      <StatusBar
        session={state.session}
        eventCount={state.totalCount}
        screen={screen}
        sortField={sortField}
      />
    </Box>
  );
}
