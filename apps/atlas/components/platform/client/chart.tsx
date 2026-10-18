"use client";

/**
 * The @xos/ui chart (visx), for server components. A client boundary file of its own (ADR 0027): a component a re-export boundary carries
 * ships to every page that imports anything from that boundary, because the bundler keeps every
 * export any server component in the app imports from it (A24-009).
 */
export { Chart } from "@xos/ui";
