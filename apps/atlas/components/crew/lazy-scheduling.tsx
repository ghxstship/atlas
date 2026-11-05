"use client";

import dynamic from "next/dynamic";

/**
 * The schedule's drag board (A132) loads when a planner sees the resource schedule, through next/dynamic, so
 * Crew > Shifts and Schedule carry none of its code with the page (ADR 0027, A24-009). A module of its own,
 * apart from lazy.tsx, so the pages that import that one do not grow either.
 */
export const SchedulingBoard = dynamic(() =>
  import("./scheduling-board").then((m) => m.SchedulingBoard),
);

/**
 * Availability polls (P8): the planner's poll results with the ask dialog they open. Loaded only when a planner
 * opens them from Crew > Shifts.
 */
export const AvailabilityPollResults = dynamic(() =>
  import("./availability-poll-results").then((m) => m.AvailabilityPollResults),
);

export const AvailabilityPollDialog = dynamic(() =>
  import("./availability-poll-dialog").then((m) => m.AvailabilityPollDialog),
);
