"use client";

/**
 * The root error boundary's view, in a module of its own so app/error.tsx loads it only when a
 * route above the org layout throws (see app/error.tsx).
 */
export { ErrorState as default } from "@xos/ui";
