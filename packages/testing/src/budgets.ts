/**
 * Performance budgets from the spec, in one place for Lighthouse CI, the k6 thresholds and the
 * journey timing assertions.
 */

/** Section 18, gate 10. */
export const webBudgets = {
  largestContentfulPaintMs: 2_500,
  interactionToNextPaintMs: 200,
  cumulativeLayoutShift: 0.1,
  routeJavaScriptGzipBytes: 200 * 1024,
} as const;

/** Section 11.2: every page reaches interactive in under 1.5 s on a mid-tier laptop. */
export const interactiveBudgetMs = 1_500;

/** Section 5.1 service level objectives, in region. */
export const apiBudgets = {
  readP95Ms: 250,
  writeP95Ms: 400,
  p99Ms: 800,
  timeToFirstByteP75Ms: 600,
  compassSyncP95Ms: 5_000,
} as const;

/** Section 5.1 load targets (k6, staging). */
export const loadTargets = {
  platformConcurrentUsers: 10_000,
  tenantConcurrentUsers: 500,
  compassDevicesPerShow: 1_000,
} as const;

/** Lighthouse CI assertions for the budgets above (Total Blocking Time stands in for INP in the lab). */
export function lighthouseAssertions(): Record<string, [string, Record<string, number>]> {
  return {
    "largest-contentful-paint": ["error", { maxNumericValue: webBudgets.largestContentfulPaintMs }],
    "cumulative-layout-shift": ["error", { maxNumericValue: webBudgets.cumulativeLayoutShift }],
    "total-blocking-time": ["error", { maxNumericValue: webBudgets.interactionToNextPaintMs }],
    interactive: ["warn", { maxNumericValue: interactiveBudgetMs }],
    "resource-summary:script:size": [
      "error",
      { maxNumericValue: webBudgets.routeJavaScriptGzipBytes },
    ],
    "categories:accessibility": ["error", { minScore: 1 }],
  };
}
