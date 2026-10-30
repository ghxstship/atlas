/**
 * Project measurement (A98, RRR-143, finding A65-030, migrations 1550 and 1551): the metric and unit catalog, the
 * objectives recorded at gate 1, the figures measured against them with their correction ledger, the earned media
 * coverage gate 8 counts, and the summary that compares them. Additive resources of the Projects module (v1 is frozen,
 * Section 10.1). Every resource reads under projects.gate.read on the project and writes under
 * projects.gate.evidence.write; the database guards refuse a unit of another dimension, a day after today on the
 * project's calendar, a correction without a reason and, once gate 1 is passed, an objective change by anyone but a gate
 * approver. A figure that was not measured is null and never zero.
 */
import { z } from "@hono/zod-openapi";
import { defineResource, fields } from "@xos/schemas";
import type { CapabilityRule } from "../../capabilities.ts";
import { editDefinition, orNull } from "../../correct.ts";
import { resource } from "../../define.ts";
import type { ResourceSpec } from "../../types.ts";
import { Constants } from "@xos/data/database.types";

const DIMENSIONS = ["Mass", "Volume", "Energy", "Emissions", "Count", "Percent"] as const;
const SOURCE = z
  .enum(Constants.app.Enums.measurement_source)
  .meta({ description: "How the figure reached XOS.", example: "Import" });
const unitCode = (description: string) =>
  z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .meta({ description, example: "kg" });
const metricCode = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/)
  .meta({ description: "Metric (app.measurement_metrics).", example: "waste_generated" });
const figure = (description: string, example: number) => fields.quantity(description, example);
const sourceReference = orNull(
  fields.text(
    "What the figure came from, such as an invoice, a meter reading or a file name.",
    "Hauler invoice 4471",
  ),
);
const note = orNull(fields.text("Note.", "Two roll-off containers.", 2000));
/** Audit columns are null for rows a platform process wrote. */
const audit = { nullable: ["created_by", "updated_by"] };

// Catalog ------------------------------------------------------------------------------------------------------------

const MeasurementMetric = defineResource({
  name: "MeasurementMetric",
  table: "app.measurement_metrics",
  base: "view",
  description:
    "A figure a project measures against its gate 1 objectives (Section 4.10): sustainability, audience, earned media or sentiment. Canon's metric table holds reference values, so each metric names the canon metric that benchmarks it where canon states one.",
  fields: {
    metric_code: metricCode,
    family: z
      .enum(["Sustainability", "Audience", "Earned Media", "Sentiment"])
      .meta({ description: "Family of the figure.", example: "Sustainability" }),
    dimension: z
      .enum(DIMENSIONS)
      .meta({ description: "Dimension of the figure.", example: "Mass" }),
    base_unit_code: unitCode("Unit totals and comparisons are computed in."),
    aggregation: z.enum(["Sum", "Latest"]).meta({
      description:
        "How a project's figures combine: each adds to the total (Sum) or the latest measured one stands (Latest).",
      example: "Sum",
    }),
    is_derived: fields.bool(
      "True when the figure is computed from the coverage records rather than entered.",
      false,
    ),
    lower_bound: orNull(figure("Lowest figure accepted, in the base unit.", 0)),
    upper_bound: orNull(figure("Highest figure accepted, in the base unit.", 100)),
    canon_domain: orNull(
      fields.text("Domain of the benchmarking canon metric.", "site_services", 200),
    ),
    canon_item: orNull(
      fields.text("Item of the benchmarking canon metric.", "Waste lbs per guest per day", 300),
    ),
    canon_value_numeric: orNull(figure("The canon benchmark as a number.", 2.4)),
    canon_value_text: orNull(fields.text("The canon benchmark in words.", "1.9 kW continuous")),
    canon_qualifier: orNull(fields.text("Qualifier of the canon benchmark.", "MODELED event avg")),
    ordinal: fields.int("Display order.", 1, 1),
  },
});

const MeasurementUnit = defineResource({
  name: "MeasurementUnit",
  table: "app.measurement_units",
  base: "view",
  description:
    "A unit a figure or objective is entered in, with its exact factor to the base unit of its dimension and whether reports show the dimension in it for metric or imperial readers.",
  fields: {
    unit_code: unitCode("Unit code."),
    dimension: z.enum(DIMENSIONS).meta({ description: "Dimension of the unit.", example: "Mass" }),
    factor_to_base: figure("Base units in one of this unit.", 0.45359237),
    unit_system: z
      .enum(["Metric", "Imperial", "Either"])
      .meta({ description: "Measurement system of the unit.", example: "Imperial" }),
    is_display: fields.bool(
      "True for the unit reports show the dimension in for readers of its system.",
      true,
    ),
    ordinal: fields.int("Display order.", 3, 1),
  },
});

const MeasurementMetricTag = defineResource({
  name: "MeasurementMetricTag",
  table: "app.measurement_metric_tags",
  base: "view",
  description:
    "A Bible sustainability tag (Bible tab 09) a sustainability figure is reported against (Section 4.10).",
  fields: {
    metric_code: metricCode,
    tag_id: fields.code("Canon tag code.", "TAG-005"),
    tag: fields.text("Tag value as written in canon.", "REUSABLE", 200),
  },
});

// Objectives and figures ---------------------------------------------------------------------------------------------

const ProjectObjective = editDefinition(
  defineResource({
    name: "ProjectObjective",
    table: "app.project_objectives",
    description:
      "A measurable objective recorded at gate 1 (canon criterion G1.OBJECTIVES_STATED): one target per metric and project, which gate 8 measures against. Once gate 1 is passed only a gate approver (projects.gate.transition) sets, changes or withdraws one; every change is in the audit ledger.",
    immutable: ["project_id", "metric_code"],
    fields: {
      project_id: fields.ref("project"),
      metric_code: metricCode,
      direction: z.enum(Constants.app.Enums.objective_direction).meta({
        description: "Met by reaching the target (At Least) or by staying within it (At Most).",
        example: "At Most",
      }),
      target_value: figure("Target figure, in unit_code.", 2),
      unit_code: unitCode("Unit of the target, of the metric's dimension."),
      note,
    },
  }),
  audit,
);

const ProjectMeasurement = editDefinition(
  defineResource({
    name: "ProjectMeasurement",
    table: "app.project_measurements",
    description:
      "A figure measured on a project (Section 4.10) for one metric, day and source. A null value records that the figure was not measured (Unmeasured), never zero. Correcting the value, unit or day needs correction_reason and writes the change to the correction ledger. Who recorded it and when are created_by and created_at.",
    immutable: ["project_id", "metric_code", "source"],
    fields: {
      project_id: fields.ref("project"),
      metric_code: metricCode,
      measured_on: fields.date(
        "Day the figure covers, on the project's calendar; today there when omitted, never later.",
      ),
      value: orNull(figure("The figure in unit_code; null when not measured.", 1200)),
      unit_code: orNull(unitCode("Unit of the figure, of the metric's dimension.")),
      source: SOURCE,
      source_reference: sourceReference,
      source_uri: orNull(
        fields.text(
          "Link to the source: an http(s) URL or a URN.",
          "https://hauler.example/invoices/4471",
          2000,
        ),
      ),
      note,
    },
  }),
  {
    ...audit,
    optionalOnCreate: ["measured_on", "source"],
    add: {
      correction_reason: {
        schema: fields.text(
          "Why the figure is corrected: required when the value, unit or day changes, kept in the correction ledger and never returned.",
          "Weighbridge ticket supersedes the estimate.",
          500,
        ),
        update: true,
        read: false,
      },
    },
  },
);

const ProjectMeasurementCorrection = editDefinition(
  defineResource({
    name: "ProjectMeasurementCorrection",
    table: "app.project_measurement_corrections",
    description:
      "An entry of the append-only correction ledger: a figure corrected, withdrawn or restored, with the figure before and after and the reason. Who changed it and when are created_by and created_at.",
    fields: {
      project_measurement_id: fields.ref("figure that changed"),
      correction_kind: z
        .enum(Constants.app.Enums.measurement_correction_kind)
        .meta({ description: "What changed the figure.", example: "Corrected" }),
      previous_value: orNull(figure("Value before the change; null when Unmeasured.", 1200)),
      previous_unit_code: orNull(unitCode("Unit before the change.")),
      previous_measured_on: fields.date("Day before the change."),
      value: orNull(figure("Value after the change; null when Unmeasured.", 1.25)),
      unit_code: orNull(unitCode("Unit after the change.")),
      measured_on: fields.date("Day after the change."),
      reason: orNull(
        fields.text("Why the figure changed.", "Weighbridge ticket supersedes the estimate.", 500),
      ),
    },
  }),
  audit,
);

const EarnedMediaItem = editDefinition(
  defineResource({
    name: "EarnedMediaItem",
    table: "app.earned_media_items",
    description:
      "A piece of earned media coverage of a project (gate 8, G8.MEASUREMENT_REPORTED), sourced, dated and linked. The earned media figures of the measurement summary are computed from these rows. A reach the source does not report is null (Unmeasured); a tone is null until rated.",
    immutable: ["project_id"],
    fields: {
      project_id: fields.ref("project"),
      title: fields.text("Headline or title of the coverage.", "Summer Series opens on the pier"),
      outlet: fields.text("Publication, station, channel or account that ran it.", "WLRN", 200),
      medium: z
        .enum(Constants.app.Enums.coverage_medium)
        .meta({ description: "Where the coverage ran.", example: "Broadcast" }),
      published_on: fields.date("Day it ran, on the project's calendar; never after today there."),
      url: orNull(fields.url("Link to the coverage; one live row per link in a project.")),
      reach: orNull(
        fields.int("Audience the outlet reports for the piece; null when unreported.", 120000),
      ),
      tone: orNull(
        z.enum(Constants.app.Enums.coverage_tone).meta({
          description: "Sentiment of the coverage; null until rated.",
          example: "Positive",
        }),
      ),
      source: SOURCE,
      source_reference: sourceReference,
      note,
    },
  }),
  { ...audit, optionalOnCreate: ["source"] },
);

const ProjectMeasurementSummary = defineResource({
  name: "ProjectMeasurementSummary",
  table: "app.project_measurement_summary",
  base: "view",
  description:
    "Gate 8 measurement against the gate 1 objectives, per project and metric, in the metric's base unit. Totals cover measured figures only, with the unmeasured count beside them; with nothing measured the figure is null (Unmeasured), never zero.",
  fields: {
    project_id: fields.ref("project"),
    metric_code: metricCode,
    family: z
      .enum(["Sustainability", "Audience", "Earned Media", "Sentiment"])
      .meta({ description: "Family of the figure.", example: "Sustainability" }),
    dimension: z
      .enum(DIMENSIONS)
      .meta({ description: "Dimension of the figure.", example: "Mass" }),
    base_unit_code: unitCode("Unit of target_base and measured_base."),
    aggregation: z
      .enum(["Sum", "Latest"])
      .meta({ description: "How figures combine.", example: "Sum" }),
    objective_id: orNull(fields.ref("live gate 1 objective for the metric")),
    direction: orNull(
      z
        .enum(Constants.app.Enums.objective_direction)
        .meta({ description: "Direction of the objective.", example: "At Most" }),
    ),
    target_value: orNull(figure("Target as set, in target_unit_code.", 2)),
    target_unit_code: orNull(unitCode("Unit the target was set in.")),
    target_base: orNull(figure("Target in the base unit.", 2000)),
    measured_count: fields.int("Figures with a value.", 2),
    unmeasured_count: fields.int("Figures recorded as not measured; never counted as zero.", 1),
    measured_base: orNull(
      figure(
        "Total (Sum) or latest figure (Latest) in the base unit; null when nothing was measured.",
        1953.59237,
      ),
    ),
    last_measured_on: orNull(fields.date("Day of the most recent measured figure.")),
    outcome: orNull(
      z.enum(["Met", "Not Met", "Incomplete", "Unmeasured"]).meta({
        description:
          "Met, Not Met, Incomplete (unmeasured figures leave the objective undecided) or Unmeasured; null without an objective.",
        example: "Met",
      }),
    ),
  },
});

const read: CapabilityRule = { read: "projects.gate.read" };
const readWrite: CapabilityRule = {
  read: "projects.gate.read",
  write: "projects.gate.evidence.write",
};

export const measurementResources: readonly ResourceSpec[] = [
  resource("Projects", "/measurement-metrics", MeasurementMetric, {
    verbs: ["list"],
    order: { by: ["ordinal"], numeric: false },
  }),
  resource("Projects", "/measurement-units", MeasurementUnit, {
    verbs: ["list"],
    order: { by: ["ordinal"], numeric: false },
  }),
  resource("Projects", "/measurement-metric-tags", MeasurementMetricTag, {
    verbs: ["list"],
    order: { by: ["metric_code", "tag_id"], numeric: false },
  }),
  resource("Projects", "/project-objectives", ProjectObjective),
  resource("Projects", "/project-measurements", ProjectMeasurement),
  resource("Projects", "/project-measurement-corrections", ProjectMeasurementCorrection, {
    verbs: ["list", "get"],
  }),
  resource("Projects", "/earned-media-items", EarnedMediaItem),
  resource("Projects", "/project-measurement-summary", ProjectMeasurementSummary, {
    verbs: ["list"],
    order: { by: ["project_id", "metric_code"], numeric: false },
    label: "project measurement summary row",
  }),
];

export const measurementCapabilities: Readonly<Record<string, CapabilityRule>> = {
  measurementMetrics: read,
  measurementUnits: read,
  measurementMetricTags: read,
  projectObjectives: readWrite,
  projectMeasurements: readWrite,
  projectMeasurementCorrections: read,
  earnedMediaItems: readWrite,
  projectMeasurementSummary: read,
};
