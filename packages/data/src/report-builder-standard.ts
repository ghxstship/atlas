import type { ReportDefinition } from "./report-builder.ts";

/**
 * The standard crew reports (B9, migration 2987, ADR 0148 decision 5), apart from report-builder.ts because Atlas's pages
 * alone read them, and the report-run worker's Edge bundle carries that module.
 */

/** A code-defined report every org can open (B9, ADR 0148 decision 5); Save as my report makes the editable copy. */
export interface StandardReport {
  /** Stable code, as the builder's ?standard= reads it; its name is the catalog key `builder.standard.<code>`. */
  readonly code: string;
  readonly definition: ReportDefinition;
}

function standard(
  code: string,
  name: string,
  d: Pick<ReportDefinition, "sourceCode" | "chart" | "groupBy" | "fields" | "filters">,
): StandardReport {
  return {
    code,
    definition: { id: null, name, customObjectTypeId: null, shared: false, mine: true, ...d },
  };
}

/** The five standard crew reports over the crew sources (G-131). Nothing is seeded per org. */
export const STANDARD_REPORTS: readonly StandardReport[] = [
  standard("crew-utilization", "Crew utilization", {
    sourceCode: "crew_hours",
    chart: "Bar",
    groupBy: "worker_name",
    fields: [
      { field: "shift_id", aggregate: "Count" },
      { field: "scheduled_hours", aggregate: "Sum" },
      { field: "actual_hours", aggregate: "Sum" },
    ],
    filters: [],
  }),
  standard("crew-invitation-responses", "Invitation responses", {
    sourceCode: "crew_responses",
    chart: "Pie",
    groupBy: "answer",
    fields: [{ field: "kind", aggregate: "Count" }],
    filters: [{ field: "kind", operator: "eq", value: "Offer" }],
  }),
  standard("crew-removals", "Crew removals", {
    sourceCode: "crew_removals",
    chart: "Table",
    groupBy: null,
    fields: [
      { field: "removed_at", aggregate: "None" },
      { field: "person_name", aggregate: "None" },
      { field: "role_code", aggregate: "None" },
      { field: "reason", aggregate: "None" },
    ],
    // An agency withdrawing a Draft is not a removal.
    filters: [{ field: "from_state", operator: "eq", value: "Accepted" }],
  }),
  standard("crew-ratings", "Crew ratings", {
    sourceCode: "crew_ratings",
    chart: "Bar",
    groupBy: "party_name",
    fields: [
      { field: "score", aggregate: "Average" },
      { field: "submitted_at", aggregate: "Count" },
    ],
    filters: [],
  }),
  standard("crew-scheduled-vs-actual", "Scheduled against actual hours", {
    sourceCode: "crew_hours",
    chart: "Bar",
    groupBy: "role_code",
    fields: [
      { field: "scheduled_hours", aggregate: "Sum" },
      { field: "actual_hours", aggregate: "Sum" },
      { field: "variance_hours", aggregate: "Sum" },
    ],
    filters: [],
  }),
];

/** A standard report by code, or undefined. */
export function standardReportOf(code: string): StandardReport | undefined {
  return STANDARD_REPORTS.find((r) => r.code === code);
}
