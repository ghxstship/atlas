"use client";

/**
 * The client boundary for the @xos/ui chart and stat tile on the metrics page (A137). Its own module so the chart
 * library loads only with the metrics page, never with the console's other routes.
 */
export { Chart, StatTile } from "@xos/ui";
