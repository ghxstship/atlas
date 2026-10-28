export * from "./budgets.ts";
export * from "./design-audit.ts";
export { runDesignAudit, auditRoots, type DesignAuditReport } from "./design-audit-repo.ts";
export { specComponentGroups, specComponents, type SpecComponent } from "./inventory.ts";
export { percentile, summarizeLatencies, type LatencySummary } from "./latency.ts";
export { findFormsThatLoseInput, type FormFinding } from "./form-audit.ts";
export {
  acknowledgmentBudgetMs,
  describeTiming,
  latencyOf,
  probeHolds,
  workflowTargets,
  type InteractionTiming,
  type VisibleProbe,
} from "./interaction.ts";
