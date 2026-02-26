/**
 * Data-fetching hook for TUI timeline.
 *
 * Provides event list, session info, and auto-refresh via polling.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  loadConfig,
  openDatabase,
  closeDatabase,
  queryEvents,
  getActiveSession,
  getEventById,
  searchEvents,
  getDiffText,
  getLatestEnvSnapshot,
  type AditEvent,
  type AditSession,
  type Actor,
  type EventType,
  type EnvSnapshot,
} from "@adit/core";

export interface TimelineState {
  events: AditEvent[];
  session: AditSession | null;
  selectedEvent: AditEvent | null;
  loading: boolean;
  error: string | null;
  totalCount: number;
}

export interface TimelineFilters {
  actor?: Actor;
  eventType?: EventType;
  hasCheckpoint?: boolean;
  searchQuery?: string;
}

export interface UseTimelineResult {
  state: TimelineState;
  filters: TimelineFilters;
  setFilters: (f: TimelineFilters) => void;
  selectEvent: (id: string | null) => void;
  refresh: () => void;
  getEventDiff: (eventId: string) => string | null;
  getEnvSnapshot: () => EnvSnapshot | null;
}

const POLL_INTERVAL = 2000;
const DEFAULT_LIMIT = 50;

export function useTimeline(): UseTimelineResult {
  const [state, setState] = useState<TimelineState>({
    events: [],
    session: null,
    selectedEvent: null,
    loading: true,
    error: null,
    totalCount: 0,
  });
  const [filters, setFilters] = useState<TimelineFilters>({});
  const dbRef = useRef<ReturnType<typeof openDatabase> | null>(null);
  const configRef = useRef<ReturnType<typeof loadConfig> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const getDb = useCallback(() => {
    if (!dbRef.current) {
      const config = loadConfig();
      configRef.current = config;
      dbRef.current = openDatabase(config.dbPath);
    }
    return dbRef.current;
  }, []);

  const fetchData = useCallback(() => {
    try {
      const db = getDb();
      const config = configRef.current!;

      const session = getActiveSession(db, config.projectId, config.clientId);

      let events: AditEvent[];
      if (filters.searchQuery) {
        events = searchEvents(db, filters.searchQuery, DEFAULT_LIMIT);
      } else {
        events = queryEvents(db, {
          sessionId: session?.id,
          eventType: filters.eventType,
          actor: filters.actor,
          hasCheckpoint: filters.hasCheckpoint,
          limit: DEFAULT_LIMIT,
        });
      }

      setState((prev) => ({
        ...prev,
        events,
        session,
        loading: false,
        error: null,
        totalCount: events.length,
        // Preserve selection if still valid
        selectedEvent:
          prev.selectedEvent &&
          events.some((e) => e.id === prev.selectedEvent!.id)
            ? prev.selectedEvent
            : events[0] ?? null,
      }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, [getDb, filters]);

  const selectEvent = useCallback(
    (id: string | null) => {
      if (!id) {
        setState((prev) => ({ ...prev, selectedEvent: null }));
        return;
      }
      try {
        const db = getDb();
        const event = getEventById(db, id);
        setState((prev) => ({ ...prev, selectedEvent: event }));
      } catch {
        // ignore
      }
    },
    [getDb],
  );

  const getEventDiff = useCallback(
    (eventId: string): string | null => {
      try {
        const db = getDb();
        return getDiffText(db, eventId, 200);
      } catch {
        return null;
      }
    },
    [getDb],
  );

  const getEnvSnapshot = useCallback((): EnvSnapshot | null => {
    try {
      const db = getDb();
      const session = state.session;
      if (!session) return null;
      return getLatestEnvSnapshot(db, session.id);
    } catch {
      return null;
    }
  }, [getDb, state.session]);

  // Initial fetch
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Auto-refresh polling
  useEffect(() => {
    intervalRef.current = setInterval(fetchData, POLL_INTERVAL);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchData]);

  // Cleanup database on unmount
  useEffect(() => {
    return () => {
      if (dbRef.current) {
        closeDatabase(dbRef.current);
        dbRef.current = null;
      }
    };
  }, []);

  return {
    state,
    filters,
    setFilters,
    selectEvent,
    refresh: fetchData,
    getEventDiff,
    getEnvSnapshot,
  };
}
