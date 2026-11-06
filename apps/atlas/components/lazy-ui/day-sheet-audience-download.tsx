"use client";

import dynamic from "next/dynamic";

/** Show > Day sheets, "Download for…" (B7), loaded when the peek first renders it (ADR 0027). */
export const DaySheetAudienceDownload = dynamic(() =>
  import("@/components/show/day-sheet-audience-download").then((m) => m.DaySheetAudienceDownload),
);
