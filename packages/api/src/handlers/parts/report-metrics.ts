/**
 * Report metric handlers (A33): labor, incident rates and gate readiness answer ReportMetricRow, one
 * measure per row in hours or a count, from A15's report queries (packages/data/src/reports.ts), so
 * the API and Atlas show the same figures. handlers/reports.ts spreads them.
 */
import { gateReadiness, incidentsReport, laborReport } from "@xos/data/reports";
import { requireOrg } from "../../runtime/context.ts";
import type { ErasedHandler } from "../../runtime/handler.ts";
import { ok } from "../../runtime/handler.ts";
import { unwrap, type Row } from "../support/table.ts";

interface MetricRow {
  readonly dimension: string;
  readonly project_id: string | null;
  readonly measure: string;
  readonly unit: "Hours" | "Count";
  readonly value: number;
}

const hours = (minutes: number) => Math.round((minutes / 60) * 100) / 100;

/** One page holding every row: the built-in reports are bounded aggregates. */
const page = (data: readonly MetricRow[]) => ({ data, next_cursor: null });

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export const reportMetricHandlers: Readonly<Record<string, ErasedHandler>> = {
  "reports.laborCost": async (request, context) => {
    const query = request.query as Row;
    const report = unwrap(
      await laborReport(context.db, {
        orgId: requireOrg(context).id,
        projectId: str(query["project_id"]),
      }),
    );
    return ok(
      page(
        report.projects.flatMap((r) => [
          {
            dimension: r.project.key,
            project_id: r.project.id,
            measure: "worked_hours",
            unit: "Hours" as const,
            value: hours(r.workedMinutes),
          },
          {
            dimension: r.project.key,
            project_id: r.project.id,
            measure: "timesheets",
            unit: "Count" as const,
            value: r.timesheetCount,
          },
          {
            dimension: r.project.key,
            project_id: r.project.id,
            measure: "open_entries",
            unit: "Count" as const,
            value: r.openEntryCount,
          },
        ]),
      ),
    );
  },

  "reports.incidentRates": async (request, context) => {
    const query = request.query as Row;
    const projectId = str(query["project_id"]);
    const report = unwrap(
      await incidentsReport(context.db, {
        orgId: requireOrg(context).id,
        projectId,
        from: str(query["from"]),
        to: str(query["to"]) === null ? null : `${String(query["to"])}T23:59:59.999Z`,
      }),
    );
    const bySeverity = new Map<string, { total: number; open: number }>();
    for (const r of report.rows) {
      const key = r.severityLabel ?? "Unrated";
      const g = bySeverity.get(key) ?? { total: 0, open: 0 };
      g.total += r.count;
      if (r.state !== "Closed") g.open += r.count;
      bySeverity.set(key, g);
    }
    return ok(
      page(
        [...bySeverity.entries()].flatMap(([severity, g]) => [
          {
            dimension: severity,
            project_id: projectId,
            measure: "incidents",
            unit: "Count" as const,
            value: g.total,
          },
          {
            dimension: severity,
            project_id: projectId,
            measure: "open_incidents",
            unit: "Count" as const,
            value: g.open,
          },
        ]),
      ),
    );
  },

  "reports.gateReadiness": async (request, context) => {
    const query = request.query as Row;
    const rows = unwrap(
      await gateReadiness(context.db, {
        orgId: requireOrg(context).id,
        projectId: str(query["project_id"]),
      }),
    );
    return ok(
      page(
        rows
          .filter((r) => r.nextGate !== null)
          .flatMap((r) => {
            const dimension = `${r.project.key} gate ${String(r.nextGate)}`;
            const row = (measure: string, value: number): MetricRow => ({
              dimension,
              project_id: r.project.id,
              measure,
              unit: "Count",
              value,
            });
            return [
              row("blocking_met", r.blockingMet),
              row("blocking_total", r.blockingTotal),
              row("other_met", r.otherMet),
              row("other_total", r.otherTotal),
              row("ready", r.ready ? 1 : 0),
            ];
          }),
      ),
    );
  },
};
