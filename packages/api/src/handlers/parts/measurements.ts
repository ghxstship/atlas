/**
 * Project measurement handlers (A98, migrations 1550 and 1551): table-backed operations over the metric and unit
 * catalog, the gate 1 objectives, the figures and their correction ledger, earned media coverage and the measurement
 * summary. Every call runs as the caller, so the project read and write policies and the guards decide: a unit of
 * another dimension, a day after today on the project's calendar, a correction without `correction_reason` and an
 * objective change after gate 1 by anyone but a gate approver come back as 422 refusals with their rule. Objectives,
 * figures and coverage are withdrawn by soft delete; a withdrawn figure is recorded in the correction ledger.
 */
import { tableHandlers } from "../support/table.ts";

export const measurementHandlers = {
  ...tableHandlers("Projects", "measurementMetrics", { softDelete: false, key: "metric_code" }),
  ...tableHandlers("Projects", "measurementUnits", { softDelete: false, key: "unit_code" }),
  ...tableHandlers("Projects", "measurementMetricTags", { softDelete: false, key: "tag_id" }),
  ...tableHandlers("Projects", "projectObjectives"),
  ...tableHandlers("Projects", "projectMeasurements"),
  ...tableHandlers("Projects", "projectMeasurementCorrections", { softDelete: false }),
  ...tableHandlers("Projects", "earnedMediaItems"),
  ...tableHandlers("Projects", "projectMeasurementSummary", {
    softDelete: false,
    key: "metric_code",
  }),
};
