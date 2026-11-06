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
 * Availability polls (P8), loaded when a planner opens them from Crew > Shifts. They never render on the server: an
 * inert New poll button would lose a click made before its chunk arrives, so it appears when it can answer.
 */
export const AvailabilityPollResults = dynamic(
  () => import("./availability-poll-results").then((m) => m.AvailabilityPollResults),
  { ssr: false },
);

export const AvailabilityPollDialog = dynamic(() =>
  import("./availability-poll-dialog").then((m) => m.AvailabilityPollDialog),
);
