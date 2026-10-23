import type { XosClient } from "./client.ts";
import type { Database } from "./database.types.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * What already runs on its own in an org, for Settings, Automations (A86, RRR-131, finding A65-004; Section
 * 4.5.6 org settings item 20): scheduled report deliveries (0550, 1127), recurring records (0310), active
 * approval policies (1030) and live webhook endpoints (0510). Rule-based automations (triggers, conditions and actions)
 * are A91's engine in automations.ts; this read gathers the other scheduled work an Admin manages elsewhere.
 * Every read runs as the caller, so a list the viewer may not read counts as empty.
 */

export type ScheduleCadence = Database["app"]["Enums"]["schedule_cadence"];

export interface ScheduledReport {
  readonly id: string;
  readonly reportName: string;
  readonly cadence: ScheduleCadence;
  readonly nextRunAt: string;
  readonly timeZone: string;
  readonly paused: boolean;
}

export interface ScheduledWorkSummary {
  readonly scheduledReports: readonly ScheduledReport[];
  readonly recurringRecords: number;
  readonly activeApprovalPolicies: number;
  readonly liveWebhooks: number;
}

export async function getScheduledWorkSummary(
  db: XosClient,
  orgId: string,
): Promise<Result<ScheduledWorkSummary>> {
  const [schedules, recurrences, policies, webhooks] = await Promise.all([
    db
      .from("report_schedules")
      .select("id, cadence, next_run_at, time_zone, paused_at, report_definitions(name)")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .order("next_run_at")
      .limit(50),
    db
      .from("record_recurrences")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .is("deleted_at", null),
    db
      .from("approval_policies")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("policy_state", "Active")
      .is("deleted_at", null),
    db
      .from("webhook_endpoints")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .is("disabled_at", null)
      .is("deleted_at", null),
  ]);
  if (schedules.error) return fail(toDataError(schedules.error));
  if (recurrences.error) return fail(toDataError(recurrences.error));
  if (policies.error) return fail(toDataError(policies.error));
  if (webhooks.error) return fail(toDataError(webhooks.error));
  return ok({
    scheduledReports: schedules.data.map((s) => ({
      id: s.id,
      reportName: s.report_definitions?.name ?? "",
      cadence: s.cadence,
      nextRunAt: s.next_run_at,
      timeZone: s.time_zone,
      paused: s.paused_at !== null,
    })),
    recurringRecords: recurrences.count ?? 0,
    activeApprovalPolicies: policies.count ?? 0,
    liveWebhooks: webhooks.count ?? 0,
  });
}
