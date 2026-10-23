/**
 * automation-run: one pass of the automation worker (A91, RRR-136; ADR 0047). The worker lives with the automations data
 * access in @xos/data (automation-runner.ts), so the e2e journeys run exactly what the function runs. It keeps its own
 * job loop beside A83's integration runtime: both claim from the 0510 job queue, each its own job kind.
 */
export {
  AUTOMATION_RUN_JOB,
  runAutomationJobs,
  supabaseAutomationRunStore,
  type AutomationRunResult,
} from "../../../data/src/automation-runner.ts";
