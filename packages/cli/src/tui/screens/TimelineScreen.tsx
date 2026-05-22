/**
 * Main timeline screen — event list + detail panel side by side.
 */

import React from "react";
import { Box } from "ink";
import { EventList } from "../components/EventList.js";
import { EventDetail } from "../components/EventDetail.js";
import { FilterBar } from "../components/FilterBar.js";
import type { AditEvent } from "@varveai/adit-core";
import type { TimelineFilters } from "../hooks/useTimeline.js";
import type { SortField } from "../../commands/list.js";

interface TimelineScreenProps {
  events: AditEvent[];
  selectedIndex: number;
  selectedEvent: AditEvent | null;
  filters: TimelineFilters;
  showFilters: boolean;
  sortField: SortField;
  height: number;
}

export function TimelineScreen({
  events,
  selectedIndex,
  selectedEvent,
  filters,
  showFilters,
  sortField,
  height,
}: TimelineScreenProps): React.ReactElement {
  const listHeight = showFilters ? height - 4 : height - 1;

  return (
    <Box flexDirection="column" width="100%">
      <FilterBar filters={filters} visible={showFilters} />
      <Box flexDirection="row" width="100%">
        <Box width="55%" flexDirection="column">
          <EventList
            events={events}
            selectedIndex={selectedIndex}
            height={listHeight}
            sortField={sortField}
          />
        </Box>
        <Box width="45%" flexDirection="column" borderStyle="single" borderLeft borderTop={false} borderRight={false} borderBottom={false}>
          <EventDetail event={selectedEvent} />
        </Box>
      </Box>
    </Box>
  );
}
