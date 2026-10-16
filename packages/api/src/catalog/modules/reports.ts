/**
 * Reports operations beyond the frozen v1 catalog (additive only, Section 10.1). Declare new
 * resources and new actions on Reports resources here. See "Adding operations" in
 * packages/api/README.md. Corrections to frozen Reports resources follow ADR 0023 (A15); the report
 * builder tables are A18's (0550).
 */
import { z } from "@hono/zod-openapi";
import { fields, platform as pf } from "@xos/schemas";
import { defineAdditions } from "../additions.ts";
import { editShape, orNull, putActions } from "../correct.ts";
import { collectionQuery } from "../define.ts";
import { reportMetricCorrections } from "./parts/report-metrics.ts";

const label = (values: readonly [string, ...string[]], description: string) =>
  z.enum(values).meta({ description, example: values[0] });

const SINCE = "1.0.0-draft.2";

const projectFilter = (description: string) => z.uuid().optional().meta({ description });

export const additions = defineAdditions("Reports", {
  corrections: [
    ...reportMetricCorrections,
    {
      id: "report-definition-columns",
      since: SINCE,
      resources: ["reportDefinitions"],
      change:
        "`source` becomes the required `source_code`; removes `definition`; adds `chart`, `group_by_field`, `shared`, `custom_object_type_id` and the server-set owner `membership_id`.",
      reason:
        "app.report_definitions (A18, 0550) stores the source as `source_code`, the chart type and grouping as columns and sharing as `shared`, and belongs to the membership that built it. Its fields and filters are rows of app.report_fields and app.report_filters, not a JSON document (ADR 0002).",
      apply: editShape({
        rename: { source: "source_code" },
        remove: ["definition"],
        add: {
          chart: {
            schema: label(["Table", "Bar", "Line", "Area", "Pie", "Number"], "Chart type."),
            create: "optional",
          },
          group_by_field: {
            schema: orNull(fields.code("Field the rows are grouped by.", "dept_code")),
            create: "optional",
          },
          shared: {
            schema: fields.bool("Whether everyone who may read the source sees it.", false),
            create: "optional",
          },
          custom_object_type_id: {
            schema: orNull(fields.ref("custom object type, when the source is custom_object")),
            create: "optional",
          },
          membership_id: { schema: fields.ref("membership that owns the report") },
        },
      }),
    },
    {
      id: "report-run-columns",
      since: SINCE,
      resources: ["reportRuns"],
      change:
        "`format`, `run_state` and `ran_at` become `export_format`, `run_status` (Queued, Running, Succeeded or Failed) and `finished_at`; removes `document_id`; adds `run_for_membership_id`, `started_at`, `row_count`, `unpriced_count` and `last_error`.",
      reason:
        "app.report_runs (A18, 0550) queues a run for the caller's membership through app.run_report, records its status and timing, its row and unpriced counts and the last error; the output is a storage object written by the report job, not a document row.",
      apply: editShape({
        rename: { format: "export_format", run_state: "run_status", ran_at: "finished_at" },
        remove: ["document_id"],
        add: {
          run_status: {
            schema: label(["Queued", "Running", "Succeeded", "Failed"], "Run status."),
          },
          run_for_membership_id: { schema: fields.ref("membership the run is for") },
          started_at: { schema: orNull(fields.instant("When the run started.")) },
          row_count: { schema: orNull(fields.int("Rows in the output.", 42)) },
          unpriced_count: {
            schema: orNull(fields.int("Unpriced inputs left out of the money totals.", 2)),
          },
          last_error: {
            schema: orNull(fields.longText("Why the run failed.", "The source was removed.")),
          },
        },
      }),
    },
    {
      id: "report-query-filters",
      since: SINCE,
      resources: ["reports"],
      change:
        "`reports.budgetVsActual` takes `project_id` and `dimension` (account, costCenter, department, urid or project); `reports.finalCostReport` requires `project_id` and answers 422 NO_ANSWER without a gate 3 baseline; `reports.poExposure` takes `project_id` and groups by vendor.",
      reason:
        "The built-in reports of A15 (packages/data/src/reports.ts) read the working budgets (app.budget_line_facts, 0480), approved change orders and posted actuals per project; the final cost report compares one project's gate 3 baseline (app.budgets.is_baseline, 0320); purchase order exposure comes from app.purchase_order_totals per order and vendor.",
      apply: putActions([
        collectionQuery("budgetVsActual", {
          summary: "Budget versus actual",
          description:
            "Revised budget (working budget plus approved change orders) against actual spend, grouped by one dimension. Unpriced lines stay out of each sum and are counted in `unpriced_count`.",
          paged: true,
          response: pf.ReportRow.read,
          query: z.object({
            project_id: projectFilter("Only this project; every visible project when omitted."),
            dimension: z
              .enum(["account", "costCenter", "department", "urid", "project"])
              .optional()
              .meta({
                description: "Grouping dimension; defaults to account.",
                example: "account",
              }),
          }),
        }),
        collectionQuery("finalCostReport", {
          summary: "Final cost report",
          description:
            "Final cost of one project by GL account: the gate 3 baseline plus approved change orders against posted actuals from the Universal Posting Line. A project without a baseline answers 422 NO_ANSWER, never zero.",
          paged: true,
          response: pf.ReportRow.read,
          query: z.object({
            project_id: z.uuid().meta({ description: "The project reported on." }),
          }),
        }),
        collectionQuery("poExposure", {
          summary: "PO exposure",
          description:
            "Committed purchase order value (lines plus approved changes) against value received, by vendor. An order with an unpriced line stays out of each sum and is counted in `unpriced_count`.",
          paged: true,
          response: pf.ReportRow.read,
          query: z.object({
            project_id: projectFilter("Only this project; every visible project when omitted."),
          }),
        }),
      ]),
    },
  ],
});
