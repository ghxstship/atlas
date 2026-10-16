/**
 * Reports handlers (A15). Saved report definitions and runs are A18's report builder (0550): they are
 * read as the caller, and a run is queued through app.run_report for the caller's membership. The
 * built-in reports reuse A15's report queries (packages/data/src/reports.ts), so the API and Atlas
 * show the same numbers; money is a `MoneyTotal` per row (the priced inputs summed, the unpriced
 * ones counted, never coerced to zero). Labor cost, incident rates and gate readiness stay
 * document-only: their rows are hours and counts, which the money-shaped `ReportRow` cannot carry.
 */
import {
  budgetVersusActual,
  finalCostReport,
  purchaseOrderExposure,
  runReport,
  type BudgetDimension,
} from "@xos/data/reports";
import { refused } from "../problem.ts";
import { requireOrg } from "../runtime/context.ts";
import { created, defineHandlers, ok } from "../runtime/handler.ts";
import { moneyTotal } from "./finance.ts";
import { handlersFor, tableResource, unwrap } from "./support/table.ts";

const reportDefinitions = tableResource("reportDefinitions", { verbs: ["list", "get"] });
const reportRuns = tableResource("reportRuns", { verbs: ["list", "get"] });

/** One page holding every row: the built-in reports are bounded aggregates. */
const page = <T>(data: readonly T[]) => ({ data, next_cursor: null });

const total = (minor: number | null, currency: string, unpriced: number) => ({
  total_minor: minor,
  currency: currency.trim(),
  unpriced_count: unpriced,
});

export const handlers = defineHandlers("Reports", {
  ...handlersFor("Reports", reportDefinitions),
  ...handlersFor("Reports", reportRuns),

  "reportRuns.create": async ({ body }, context) => {
    const run = unwrap(
      await runReport(context.db, {
        reportDefinitionId: body.report_definition_id,
        format: body.export_format,
      }),
    );
    return created((await reportRuns.read(context, run.id)) as never);
  },

  "reports.budgetVsActual": async ({ query }, context) => {
    const report = unwrap(
      await budgetVersusActual(context.db, {
        orgId: requireOrg(context).id,
        projectId: query.project_id ?? null,
        dimension: (query.dimension ?? "account") as BudgetDimension,
      }),
    );
    return ok(
      page(
        report.rows.map((r) => ({
          dimension: r.key === "" ? "unassigned" : r.key,
          budget: total(r.pricedRevisedMinor, r.currency, r.unpricedCount),
          actual: total(r.actualMinor, r.currency, 0),
        })),
      ) as never,
    );
  },

  "reports.finalCostReport": async ({ query }, context) => {
    const report = unwrap(
      await finalCostReport(context.db, {
        orgId: requireOrg(context).id,
        projectId: query.project_id,
      }),
    );
    if (!report.hasBaseline) {
      throw refused(
        "NO_ANSWER",
        "The project has no gate 3 baseline budget, so there is nothing to compare its final cost against.",
        "final_cost_no_baseline",
      );
    }
    return ok(
      page(
        report.rows.map((r) => ({
          dimension: r.accountCode === "" ? "unassigned" : r.accountCode,
          budget: total(r.pricedRevisedMinor, r.currency, r.baselineUnpricedCount),
          actual: total(r.actualMinor, r.currency, 0),
        })),
      ) as never,
    );
  },

  "reports.poExposure": async ({ query }, context) => {
    const orders = unwrap(
      await purchaseOrderExposure(context.db, {
        orgId: requireOrg(context).id,
        projectId: query.project_id ?? null,
      }),
    );
    const groups = new Map<
      string,
      {
        vendor: string;
        currency: string;
        committed: (number | null)[];
        received: (number | null)[];
      }
    >();
    for (const o of orders) {
      const vendor = o.vendorName ?? "unassigned";
      const id = `${vendor}|${o.currency}`;
      const g = groups.get(id) ?? { vendor, currency: o.currency, committed: [], received: [] };
      g.committed.push(o.committedMinor);
      g.received.push(o.receivedMinor);
      groups.set(id, g);
    }
    return ok(
      page(
        [...groups.values()]
          .sort((a, b) => a.vendor.localeCompare(b.vendor) || a.currency.localeCompare(b.currency))
          .map((g) => ({
            dimension: g.vendor,
            budget: moneyTotal(g.committed, g.currency),
            actual: moneyTotal(g.received, g.currency),
          })),
      ) as never,
    );
  },
});
