"use client";

import dynamic from "next/dynamic";

/**
 * The schedule's day grid (B4, G-41), loaded when first opened: it brings SpreadsheetGrid, time shorthand and quick
 * add's date reading with it, none of which a Schedule page needs until someone edits a day as a grid (ADR 0027).
 */
export const DayGrid = dynamic(() =>
  import("@/components/schedule/day-grid").then((m) => m.DayGrid),
);
