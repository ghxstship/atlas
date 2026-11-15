"use client";

/**
 * The scroll region of ComparisonTable, as its own client module. ScrollRegion measures its
 * overflow, so it runs in the browser; the table around it renders on the server (ADR 0027).
 */
export { ScrollRegion as ComparisonScroll } from "../Layout/ScrollRegion.tsx";
