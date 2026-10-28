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
