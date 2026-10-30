"use client";

import dynamic from "next/dynamic";

/**
 * The run of show's cue grid (B4, G-41), loaded when first opened: it brings SpreadsheetGrid and time shorthand with
 * it, which the running order needs only while someone edits it as a grid (ADR 0027).
 */
export const CueGrid = dynamic(() => import("@/components/show/cue-grid").then((m) => m.CueGrid));
