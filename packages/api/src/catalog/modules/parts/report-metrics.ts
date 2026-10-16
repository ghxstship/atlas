/**
 * Report metrics (A33): the built-in reports whose figures are hours and counts, not money.
 * `reports.laborCost`, `reports.incidentRates` and `reports.gateReadiness` were frozen answering the
 * money-shaped ReportRow, which cannot carry them; they answer ReportMetricRow instead (ADR 0023).
 * catalog/modules/reports.ts spreads the correction into the Reports additions.
 */
import { z } from "@hono/zod-openapi";
import { fields } from "@xos/schemas";
import { putActions } from "../../correct.ts";
import type { CorrectionInput } from "../../corrections.ts";
import { collectionQuery } from "../../define.ts";

/** One measure of one row of a report, in long form: hours or a count, never money. */
export const ReportMetricRow = z
  .object({
    dimension: z.string().meta({
      description: "Grouping value: a project key, a project key and gate, or a severity.",
      example: "NWL",
    }),
    project_id: fields.ref("project the row is about, when it is about one").nullable(),
    measure: z
      .string()
      .regex(/^[a-z][a-z_]*$/)
      .meta({
        description:
          "What is measured: worked_hours, timesheets and open_entries (labor), incidents and open_incidents (incident rates), blocking_met, blocking_total, other_met, other_total and ready (gate readiness).",
        example: "worked_hours",
      }),
    unit: z.enum(["Hours", "Count"]).meta({ description: "Unit of the value.", example: "Hours" }),
    value: z.number().meta({
      description: "The measure: hours to two decimals, or a whole count (ready is 1 or 0).",
      example: 312.5,
    }),
  })
  .meta({
    id: "ReportMetricRow",
    description:
      "One measure of a built-in report row, in hours or a count. Reports that total money answer ReportRow instead.",
  });

const projectFilter = z
  .uuid()
  .optional()
  .meta({ description: "Only this project; every visible project when omitted." });

export const reportMetricCorrections: readonly CorrectionInput[] = [
  {
    id: "report-metric-rows",
    since: "1.0.0-draft.2",
    resources: ["reports"],
    components: ["schemas/ReportMetricRow"],
    change:
      "`reports.laborCost`, `reports.incidentRates` and `reports.gateReadiness` answer pages of ReportMetricRow (dimension, project, measure, unit and value) instead of ReportRow, and take `project_id`; `reports.incidentRates` also takes `from` and `to`.",
    reason:
      "Their figures are hours and counts (app.timesheet_hours from 0480, app.incidents from 0353, app.gate_criteria_status from 0301), which the money-shaped ReportRow (budget and actual MoneyTotals) cannot carry; the labor report masks pay, so it reports worked time, not cost.",
    apply: putActions([
      collectionQuery("laborCost", {
        summary: "Labor",
        description:
          "Worked hours, timesheets and timesheets with an open entry, per readable project, from submitted time (app.timesheet_hours). Pay is Restricted and never reported here.",
        paged: true,
        response: ReportMetricRow,
        query: z.object({ project_id: projectFilter }),
      }),
      collectionQuery("incidentRates", {
        summary: "Incident rates",
        description:
          "Incidents and open incidents per canon severity, optionally for one project and a window of occurrence.",
        paged: true,
        response: ReportMetricRow,
        query: z.object({
          project_id: projectFilter,
          from: fields.date("Occurred on or after this day.").optional(),
          to: fields.date("Occurred on or before this day.").optional(),
        }),
      }),
      collectionQuery("gateReadiness", {
        summary: "Gate readiness",
        description:
          "Criteria with evidence against the next gate of each readable project: blocking and other criteria met and in total, and whether the gate is ready.",
        paged: true,
        response: ReportMetricRow,
        query: z.object({ project_id: projectFilter }),
      }),
    ]),
  },
];
