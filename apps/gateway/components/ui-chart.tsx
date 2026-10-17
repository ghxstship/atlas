"use client";

/**
 * The client boundary for the @xos/ui chart, apart from components/ui.tsx. Every export of a client
 * boundary that any page uses ships with every page that imports the boundary, so the chart and
 * its visx code live here and load only on the pages that draw a chart (A24-009).
 */
export { Chart } from "@xos/ui";
