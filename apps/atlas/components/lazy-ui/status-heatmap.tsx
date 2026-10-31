"use client";

import dynamic from "next/dynamic";

/** @xos/ui StatusHeatmap, loaded when first rendered (see deferred.tsx and ADR 0027; R11's advancing heatmaps). */
export const StatusHeatmap = dynamic(() =>
  import("./targets/status-heatmap").then((m) => m.StatusHeatmap),
);
