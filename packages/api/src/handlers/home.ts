/**
 * Home handlers (A07): the caller's dashboard summary (Section 4.2 Home). Counts come from the
 * record spine and the evidence spine under row level security; committed spend is a NULL-aware
 * total in the org's base currency (Section 3.7).
 */
import {
  buildAlerts,
  committedSpend,
  countMyRecords,
  listBlockedRecords,
  listMyOverdueRecords,
  orgBaseCurrency,
  summarizeReadiness,
} from "@xos/data/home";
import {
  listCriterionStatus,
  listGateCriteria,
  listPhases,
  listProjects,
} from "@xos/data/projects";
import type { Result } from "@xos/data";
import type { Components } from "../contract/operations.generated.ts";
import { requireOrg, requirePerson } from "../runtime/context.ts";
import { defineHandlers, ok } from "../runtime/handler.ts";
import { problemFor } from "./projects.ts";

function must<T>(result: Result<T>): T {
  if (!result.ok) throw problemFor(result.error);
  return result.data;
}

export const handlers = defineHandlers("Home", {
  "home.get": async (_request, context) => {
    const org = requireOrg(context);
    const personId = requirePerson(context);
    const { db } = context;
    const now = new Date();
    const [open, blocked, projects, phases, criteria, blockedRecords, overdue, currency] =
      await Promise.all([
        countMyRecords(db, { orgId: org.id, personId, which: "open" }),
        countMyRecords(db, { orgId: org.id, personId, which: "blocked" }),
        listProjects(db, org.id),
        listPhases(db),
        listGateCriteria(db),
        listBlockedRecords(db, org.id),
        listMyOverdueRecords(db, { orgId: org.id, personId, now }),
        orgBaseCurrency(db, org.id),
      ]);
    const live = must(projects).filter(
      (p) => p.projectState !== "Complete" && p.projectState !== "Canceled",
    );
    const statuses = must(
      await listCriterionStatus(
        db,
        live.map((p) => p.id),
      ),
    );
    const readiness = summarizeReadiness(live, must(phases), must(criteria), statuses);
    const alerts = buildAlerts({
      readiness,
      blocked: must(blockedRecords),
      overdue: must(overdue),
      today: now.toISOString().slice(0, 10),
    });
    const spend = must(await committedSpend(db, org.id, must(currency)));
    const body: Components["HomeSummary"] = {
      open_work_count: must(open),
      blocked_work_count: must(blocked),
      projects_at_risk_count: readiness.filter((r) => r.unmet.length > 0).length,
      alert_count: alerts.length,
      committed_spend: {
        total_minor: spend.totalMinor,
        currency: spend.currency,
        unpriced_count: spend.unpricedCount,
      },
    };
    return ok(body);
  },
});
