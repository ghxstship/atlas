import { describe, expect, it } from "vitest";
import {
  COVERAGE_TONES,
  MEASUREMENT_CRITERION,
  OBJECTIVES_CRITERION,
  convertFigure,
  correctProjectMeasurement,
  displayUnitFor,
  inDisplayUnit,
  listEarnedMediaItems,
  listMeasurementCatalog,
  listMeasurementCorrections,
  listMeasurementSummary,
  listProjectMeasurements,
  listProjectObjectives,
  measurementEvidenceUri,
  projectMetricRows,
  recordEarnedMediaItem,
  recordProjectMeasurement,
  rollupByMetric,
  rollupByProject,
  saveProjectObjective,
  ticketingAttendance,
  toneBreakdown,
  unitsOf,
  withdrawEarnedMediaItem,
  withdrawProjectMeasurement,
  withdrawProjectObjective,
  type MeasurementMetric,
  type MeasurementSummaryRow,
  type MeasurementUnit,
} from "../src/measurements.ts";
import { moduleClient, stepsOf } from "./module-client.ts";

const down = { data: null, error: { code: "08006", message: "down" } };
const refused = (rule: string) => ({
  data: null,
  error: { code: "XR001", message: `${rule}: Refused.`, hint: rule },
});

// The units of migration 1550, as app.measurement_units returns them.
const UNIT_ROWS = [
  ["kg", "Mass", 1, "Metric", true],
  ["t", "Mass", 1000, "Metric", false],
  ["lb", "Mass", 0.45359237, "Imperial", true],
  ["short_ton", "Mass", 907.18474, "Imperial", false],
  ["l", "Volume", 1, "Metric", true],
  ["m3", "Volume", 1000, "Metric", false],
  ["gal", "Volume", 3.785411784, "Imperial", true],
  ["kwh", "Energy", 1, "Either", true],
  ["mwh", "Energy", 1000, "Either", false],
  ["kg_co2e", "Emissions", 1, "Either", true],
  ["t_co2e", "Emissions", 1000, "Either", false],
  ["count", "Count", 1, "Either", true],
  ["percent", "Percent", 1, "Either", true],
].map(([unit_code, dimension, factor_to_base, unit_system, is_display], i) => ({
  unit_code,
  dimension,
  factor_to_base,
  unit_system,
  is_display,
  ordinal: i + 1,
}));

const METRIC_ROWS = [
  {
    metric_code: "waste_generated",
    family: "Sustainability",
    dimension: "Mass",
    base_unit_code: "kg",
    aggregation: "Sum",
    is_derived: false,
    lower_bound: 0,
    upper_bound: null,
    canon_domain: "site_services",
    canon_item: "Waste lbs per guest per day",
    canon_value_numeric: 2.4,
    canon_value_text: null,
    canon_qualifier: "MODELED event avg",
    ordinal: 1,
  },
  {
    metric_code: "positive_sentiment",
    family: "Sentiment",
    dimension: "Percent",
    base_unit_code: "percent",
    aggregation: "Latest",
    is_derived: false,
    lower_bound: 0,
    upper_bound: 100,
    canon_domain: null,
    canon_item: null,
    canon_value_numeric: null,
    canon_value_text: null,
    canon_qualifier: null,
    ordinal: 10,
  },
  {
    metric_code: "earned_media_reach",
    family: "Earned Media",
    dimension: "Count",
    base_unit_code: "count",
    aggregation: "Sum",
    is_derived: true,
    lower_bound: 0,
    upper_bound: null,
    canon_domain: "x",
    canon_item: "y",
    canon_value_numeric: null,
    canon_value_text: "words",
    canon_qualifier: null,
    ordinal: 9,
  },
];

async function catalog() {
  const { db } = moduleClient({
    "from:measurement_metrics": [{ data: METRIC_ROWS, error: null }],
    "from:measurement_units": [{ data: UNIT_ROWS, error: null }],
    "from:measurement_metric_tags": [
      {
        data: [
          { metric_code: "waste_generated", tag_id: "TAG-005", tag: "REUSABLE" },
          { metric_code: "waste_generated", tag_id: "TAG-020", tag: "RECYCLABLE" },
        ],
        error: null,
      },
    ],
  });
  const result = await listMeasurementCatalog(db);
  if (!result.ok) throw new Error("catalog failed");
  return result.data;
}

const unit = (units: readonly MeasurementUnit[], code: string) => {
  const found = units.find((u) => u.code === code);
  if (!found) throw new Error(code);
  return found;
};

describe("measurement catalog", () => {
  it("reads the metrics with their canon benchmark and sustainability tags, and the units", async () => {
    const { metrics, units } = await catalog();
    expect(metrics.map((m) => m.code)).toEqual([
      "waste_generated",
      "positive_sentiment",
      "earned_media_reach",
    ]);
    expect(metrics[0]).toMatchObject({
      family: "Sustainability",
      dimension: "Mass",
      baseUnit: "kg",
      aggregation: "Sum",
      derived: false,
      canon: { domain: "site_services", value: "2.4", qualifier: "MODELED event avg" },
      tags: [
        { id: "TAG-005", tag: "REUSABLE" },
        { id: "TAG-020", tag: "RECYCLABLE" },
      ],
    });
    expect(metrics[1]?.canon).toBeNull();
    expect(metrics[1]?.tags).toEqual([]);
    expect(metrics[2]?.canon?.value).toBe("words");
    expect(metrics[2]?.derived).toBe(true);
    expect(units).toHaveLength(13);
    expect(unit(units, "lb")).toMatchObject({
      factor: 0.45359237,
      system: "Imperial",
      isDisplay: true,
    });
  });

  it("reports a failed read", async () => {
    const { db } = moduleClient({
      "from:measurement_metrics": [{ data: [], error: null }],
      "from:measurement_units": [down],
      "from:measurement_metric_tags": [{ data: [], error: null }],
    });
    expect(await listMeasurementCatalog(db)).toEqual({
      ok: false,
      error: { kind: "unexpected", message: "down", code: "08006" },
    });
  });

  it("names the canon criteria and the evidence URIs on the spine", () => {
    expect(OBJECTIVES_CRITERION).toBe("G1.OBJECTIVES_STATED");
    expect(MEASUREMENT_CRITERION).toBe("G8.MEASUREMENT_REPORTED");
    expect(measurementEvidenceUri("objectives", "p1")).toBe("urn:xpms:project-objectives:p1");
    expect(measurementEvidenceUri("measurement", "p1")).toBe("urn:xpms:project-measurement:p1");
    expect(COVERAGE_TONES).toEqual(["Positive", "Neutral", "Negative"]);
  });
});

describe("unit conversion", () => {
  it("offers only the units of the metric's dimension", async () => {
    const { units } = await catalog();
    expect(unitsOf(units, "Mass").map((u) => u.code)).toEqual(["kg", "t", "lb", "short_ton"]);
    expect(unitsOf(units, "Percent").map((u) => u.code)).toEqual(["percent"]);
  });

  it("shows each dimension in the person's units", async () => {
    const { units } = await catalog();
    expect(displayUnitFor(units, "Mass", "metric").code).toBe("kg");
    expect(displayUnitFor(units, "Mass", "imperial").code).toBe("lb");
    expect(displayUnitFor(units, "Volume", "metric").code).toBe("l");
    expect(displayUnitFor(units, "Volume", "imperial").code).toBe("gal");
    expect(displayUnitFor(units, "Energy", "imperial").code).toBe("kwh");
    expect(displayUnitFor(units, "Emissions", "metric").code).toBe("kg_co2e");
    expect(displayUnitFor(units, "Count", "imperial").code).toBe("count");
    // Without a display unit the base unit is used; without any unit it is a programming error.
    expect(
      displayUnitFor(
        [unit(units, "t"), unit(units, "kg")].map((u) => ({ ...u, isDisplay: false })),
        "Mass",
        "metric",
      ).code,
    ).toBe("kg");
    expect(() => displayUnitFor([], "Mass", "metric")).toThrow("No unit for Mass");
  });

  it("converts within a dimension exactly enough and keeps Unmeasured null", async () => {
    const { units } = await catalog();
    expect(convertFigure(2, unit(units, "t"), unit(units, "kg"))).toBe(2000);
    expect(convertFigure(1000, unit(units, "lb"), unit(units, "kg"))).toBeCloseTo(453.59237, 9);
    expect(convertFigure(1, unit(units, "short_ton"), unit(units, "lb"))).toBeCloseTo(2000, 9);
    expect(convertFigure(1, unit(units, "gal"), unit(units, "l"))).toBeCloseTo(3.785411784, 12);
    expect(convertFigure(0.9, unit(units, "mwh"), unit(units, "kwh"))).toBeCloseTo(900, 9);
    expect(convertFigure(5, unit(units, "kg"), unit(units, "kg"))).toBe(5);
    expect(convertFigure(null, unit(units, "kg"), unit(units, "lb"))).toBeNull();
    expect(() => convertFigure(1, unit(units, "kg"), unit(units, "l"))).toThrow(
      "Cannot convert kg (Mass) to l (Volume)",
    );
  });

  it("puts a base-unit total in the display unit and keeps null", async () => {
    const { units } = await catalog();
    const lb = inDisplayUnit(453.59237, "Mass", units, "imperial");
    expect(lb.unit.code).toBe("lb");
    expect(lb.value).toBeCloseTo(1000, 9);
    expect(inDisplayUnit(453.59237, "Mass", units, "metric")).toMatchObject({ value: 453.59237 });
    expect(inDisplayUnit(null, "Volume", units, "imperial")).toMatchObject({ value: null });
  });
});

describe("objectives", () => {
  it("lists the live objectives with who set them", async () => {
    const { db, calls } = moduleClient({
      "from:project_objectives": [
        {
          data: [
            {
              id: "o1",
              project_id: "p1",
              metric_code: "attendance",
              direction: "At Least",
              target_value: 5000,
              unit_code: "count",
              note: null,
              updated_at: "2026-10-01T00:00:00Z",
              setter: { full_name: "Erin Castillo" },
            },
            {
              id: "o2",
              project_id: "p1",
              metric_code: "waste_generated",
              direction: "At Most",
              target_value: 2,
              unit_code: "t",
              note: "Two roll-offs.",
              updated_at: "2026-10-01T00:00:00Z",
              setter: null,
            },
          ],
          error: null,
        },
      ],
    });
    const result = await listProjectObjectives(db, "p1");
    expect(result.ok && result.data.map((o) => [o.metricCode, o.targetValue, o.setBy])).toEqual([
      ["attendance", 5000, "Erin Castillo"],
      ["waste_generated", 2, null],
    ]);
    expect(stepsOf(calls[0], "eq")).toEqual([["project_id", "p1"]]);
    expect(stepsOf(calls[0], "is")).toEqual([["deleted_at", null]]);
  });

  it("sets a new objective and changes a live one", async () => {
    const { db, calls } = moduleClient({
      "from:project_objectives": [
        { data: { id: "o9" }, error: null },
        { data: [{ id: "o9" }], error: null },
        { data: [], error: null },
        refused("project_objectives_locked"),
      ],
    });
    const input = {
      id: null,
      projectId: "p1",
      metricCode: "attendance",
      direction: "At Least" as const,
      targetValue: 5000,
      unitCode: "count",
      note: "  ",
    };
    expect(await saveProjectObjective(db, input)).toEqual({ ok: true, data: { id: "o9" } });
    expect(stepsOf(calls[0], "insert")[0]?.[0]).toEqual({
      project_id: "p1",
      metric_code: "attendance",
      direction: "At Least",
      target_value: 5000,
      unit_code: "count",
      note: null,
    });
    expect(await saveProjectObjective(db, { ...input, id: "o9", targetValue: 5500 })).toEqual({
      ok: true,
      data: { id: "o9" },
    });
    expect(stepsOf(calls[1], "update")[0]?.[0]).toMatchObject({ target_value: 5500 });
    expect(stepsOf(calls[1], "eq")).toEqual([["id", "o9"]]);
    expect(await saveProjectObjective(db, { ...input, id: "gone" })).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect(await saveProjectObjective(db, { ...input, id: "o9" })).toEqual({
      ok: false,
      error: { kind: "refusal", rule: "project_objectives_locked", message: "Refused." },
    });
  });

  it("withdraws an objective", async () => {
    const { db, calls } = moduleClient({
      "from:project_objectives": [{ data: [{ id: "o1" }], error: null }],
    });
    const now = new Date("2026-10-21T12:00:00Z");
    expect(await withdrawProjectObjective(db, "o1", now)).toEqual({ ok: true, data: null });
    expect(stepsOf(calls[0], "update")[0]?.[0]).toEqual({ deleted_at: now.toISOString() });
  });
});

describe("measurements", () => {
  it("lists live figures newest first, keeping an unmeasured figure null", async () => {
    const { db, calls } = moduleClient({
      "from:project_measurements": [
        {
          data: [
            {
              id: "m1",
              project_id: "p1",
              metric_code: "water_used",
              measured_on: "2026-10-20",
              value: null,
              unit_code: null,
              source: "Manual",
              source_reference: null,
              source_uri: null,
              note: null,
              created_at: "2026-10-20T15:00:00Z",
              recorder: null,
            },
            {
              id: "m2",
              project_id: "p1",
              metric_code: "waste_generated",
              measured_on: "2026-10-18",
              value: 1200,
              unit_code: "kg",
              source: "Import",
              source_reference: "Hauler invoice 4471",
              source_uri: "https://hauler.example.test/4471",
              note: null,
              created_at: "2026-10-19T15:00:00Z",
              recorder: { full_name: "Erin Castillo" },
            },
          ],
          error: null,
        },
      ],
    });
    const result = await listProjectMeasurements(db, "p1");
    expect(result.ok && result.data.map((m) => [m.metricCode, m.value, m.recordedBy])).toEqual([
      ["water_used", null, null],
      ["waste_generated", 1200, "Erin Castillo"],
    ]);
    expect(stepsOf(calls[0], "order")).toEqual([
      ["measured_on", { ascending: false }],
      ["created_at", { ascending: false }],
    ]);
  });

  it("records a figure, or that it was not measured", async () => {
    const { db, calls } = moduleClient({
      "from:project_measurements": [
        { data: { id: "m3" }, error: null },
        { data: { id: "m4" }, error: null },
        refused("measurement_in_future"),
      ],
    });
    expect(
      await recordProjectMeasurement(db, {
        projectId: "p1",
        metricCode: "energy_used",
        measuredOn: "2026-10-19",
        value: 0.9,
        unitCode: "mwh",
        source: "Import",
        sourceReference: " meter-export.csv ",
        sourceUri: "",
        note: null,
      }),
    ).toEqual({ ok: true, data: { id: "m3" } });
    expect(stepsOf(calls[0], "insert")[0]?.[0]).toEqual({
      project_id: "p1",
      metric_code: "energy_used",
      measured_on: "2026-10-19",
      value: 0.9,
      unit_code: "mwh",
      source: "Import",
      source_reference: "meter-export.csv",
      source_uri: null,
      note: null,
    });
    await recordProjectMeasurement(db, {
      projectId: "p1",
      metricCode: "water_used",
      measuredOn: null,
      value: null,
      unitCode: "l",
    });
    // The day is left to the database (today on the project's calendar) and an unmeasured figure carries no unit.
    expect(stepsOf(calls[1], "insert")[0]?.[0]).toEqual({
      project_id: "p1",
      metric_code: "water_used",
      value: null,
      unit_code: null,
      source: "Manual",
      source_reference: null,
      source_uri: null,
      note: null,
    });
    const future = await recordProjectMeasurement(db, {
      projectId: "p1",
      metricCode: "energy_used",
      measuredOn: "2099-01-01",
      value: 1,
      unitCode: "kwh",
    });
    expect(future.ok === false && future.error.kind).toBe("refusal");
  });

  it("corrects a figure with its reason and withdraws one", async () => {
    const { db, calls } = moduleClient({
      "from:project_measurements": [
        { data: [{ id: "m2" }], error: null },
        { data: [{ id: "m2" }], error: null },
        { data: [{ id: "m2" }], error: null },
        { data: [{ id: "m2" }], error: null },
      ],
    });
    expect(
      await correctProjectMeasurement(db, {
        id: "m2",
        measuredOn: "2026-10-18",
        value: 1.25,
        unitCode: "t",
        reason: " Weighbridge ticket. ",
      }),
    ).toEqual({ ok: true, data: null });
    expect(stepsOf(calls[0], "update")[0]?.[0]).toEqual({
      measured_on: "2026-10-18",
      value: 1.25,
      unit_code: "t",
      correction_reason: "Weighbridge ticket.",
    });
    await correctProjectMeasurement(db, {
      id: "m2",
      measuredOn: "2026-10-18",
      value: null,
      unitCode: "t",
      reason: "Scale was broken.",
    });
    expect(stepsOf(calls[1], "update")[0]?.[0]).toMatchObject({ value: null, unit_code: null });
    const now = new Date("2026-10-21T12:00:00Z");
    expect(await withdrawProjectMeasurement(db, { id: "m2", reason: "Duplicate." }, now)).toEqual({
      ok: true,
      data: null,
    });
    expect(stepsOf(calls[2], "update")[0]?.[0]).toEqual({
      deleted_at: now.toISOString(),
      correction_reason: "Duplicate.",
    });
    await withdrawProjectMeasurement(db, { id: "m2" });
    expect(stepsOf(calls[3], "update")[0]?.[0]).toMatchObject({ correction_reason: null });
  });

  it("lists the correction ledger of a project", async () => {
    const { db, calls } = moduleClient({
      "from:project_measurement_corrections": [
        {
          data: [
            {
              id: "c1",
              project_measurement_id: "m2",
              correction_kind: "Corrected",
              previous_value: 1200,
              previous_unit_code: "kg",
              previous_measured_on: "2026-10-18",
              value: 1.25,
              unit_code: "t",
              measured_on: "2026-10-18",
              reason: "Weighbridge ticket.",
              created_at: "2026-10-20T10:00:00Z",
              corrector: { full_name: "Erin Castillo" },
            },
            {
              id: "c2",
              project_measurement_id: "m2",
              correction_kind: "Withdrawn",
              previous_value: null,
              previous_unit_code: null,
              previous_measured_on: "2026-10-18",
              value: null,
              unit_code: null,
              measured_on: "2026-10-18",
              reason: null,
              created_at: "2026-10-20T11:00:00Z",
              corrector: null,
            },
          ],
          error: null,
        },
      ],
    });
    const result = await listMeasurementCorrections(db, "p1");
    expect(
      result.ok && result.data.map((c) => [c.kind, c.previousValue, c.value, c.correctedBy]),
    ).toEqual([
      ["Corrected", 1200, 1.25, "Erin Castillo"],
      ["Withdrawn", null, null, null],
    ]);
    expect(stepsOf(calls[0], "eq")).toEqual([["measurement.project_id", "p1"]]);
  });
});

describe("earned media", () => {
  it("lists live coverage and records and withdraws a piece", async () => {
    const { db, calls } = moduleClient({
      "from:earned_media_items": [
        {
          data: [
            {
              id: "e1",
              project_id: "p1",
              title: "Summer Series opens",
              outlet: "Miami Herald",
              medium: "Online",
              published_on: "2026-10-18",
              url: "https://news.example.test/a",
              reach: 120000,
              tone: "Positive",
              source: "Manual",
              source_reference: null,
              note: null,
              recorder: { full_name: "Erin Castillo" },
            },
            {
              id: "e2",
              project_id: "p1",
              title: "Weekend picks",
              outlet: "WLRN",
              medium: "Broadcast",
              published_on: "2026-10-17",
              url: null,
              reach: null,
              tone: null,
              source: "Import",
              source_reference: "export.csv",
              note: null,
              recorder: null,
            },
          ],
          error: null,
        },
        { data: { id: "e3" }, error: null },
        { data: null, error: { code: "23505", message: "duplicate key" } },
        { data: [{ id: "e3" }], error: null },
      ],
    });
    const listed = await listEarnedMediaItems(db, "p1");
    expect(listed.ok && listed.data.map((e) => [e.outlet, e.reach, e.tone, e.recordedBy])).toEqual([
      ["Miami Herald", 120000, "Positive", "Erin Castillo"],
      ["WLRN", null, null, null],
    ]);
    const input = {
      projectId: "p1",
      title: " Opening night reel ",
      outlet: " @northwindlive ",
      medium: "Social" as const,
      publishedOn: "2026-10-16",
      url: "",
      reach: 5000,
    };
    expect(await recordEarnedMediaItem(db, input)).toEqual({ ok: true, data: { id: "e3" } });
    expect(stepsOf(calls[1], "insert")[0]?.[0]).toEqual({
      project_id: "p1",
      title: "Opening night reel",
      outlet: "@northwindlive",
      medium: "Social",
      published_on: "2026-10-16",
      url: null,
      reach: 5000,
      tone: null,
      source: "Manual",
      source_reference: null,
      note: null,
    });
    const duplicate = await recordEarnedMediaItem(db, { ...input, url: "https://a.test/x" });
    expect(duplicate.ok === false && duplicate.error.kind).toBe("conflict");
    expect(await withdrawEarnedMediaItem(db, "e3")).toEqual({ ok: true, data: null });
  });

  it("breaks coverage down by tone, counting unrated pieces apart", () => {
    expect(
      toneBreakdown([
        { tone: "Positive" },
        { tone: "Positive" },
        { tone: "Negative" },
        { tone: null },
      ]),
    ).toEqual({ Positive: 2, Neutral: 0, Negative: 1, Unrated: 1 });
  });
});

describe("summary and rollups", () => {
  const row = (over: Partial<MeasurementSummaryRow>): MeasurementSummaryRow => ({
    projectId: "p1",
    metricCode: "waste_generated",
    family: "Sustainability",
    dimension: "Mass",
    aggregation: "Sum",
    objectiveId: null,
    direction: null,
    targetValue: null,
    targetUnitCode: null,
    targetBase: null,
    measuredCount: 0,
    unmeasuredCount: 0,
    measuredBase: null,
    lastMeasuredOn: null,
    outcome: null,
    ...over,
  });

  it("reads the summary for one project or the whole org", async () => {
    const raw = {
      project_id: "p1",
      metric_code: "water_used",
      family: "Sustainability",
      dimension: "Volume",
      aggregation: "Sum",
      objective_id: "o1",
      direction: "At Most",
      target_value: 50,
      target_unit_code: "m3",
      target_base: 50000,
      measured_count: 0,
      unmeasured_count: 1,
      measured_base: null,
      last_measured_on: null,
      outcome: "Unmeasured",
    };
    const { db, calls } = moduleClient({
      "from:project_measurement_summary": [
        { data: [raw], error: null },
        {
          data: [
            {
              ...raw,
              project_id: null,
              metric_code: null,
              measured_count: null,
              unmeasured_count: null,
            },
          ],
          error: null,
        },
      ],
    });
    const one = await listMeasurementSummary(db, { orgId: "org", projectId: "p1" });
    expect(one.ok && one.data[0]).toEqual({
      projectId: "p1",
      metricCode: "water_used",
      family: "Sustainability",
      dimension: "Volume",
      aggregation: "Sum",
      objectiveId: "o1",
      direction: "At Most",
      targetValue: 50,
      targetUnitCode: "m3",
      targetBase: 50000,
      measuredCount: 0,
      unmeasuredCount: 1,
      measuredBase: null,
      lastMeasuredOn: null,
      outcome: "Unmeasured",
    });
    expect(stepsOf(calls[0], "eq")).toEqual([
      ["org_id", "org"],
      ["project_id", "p1"],
    ]);
    const all = await listMeasurementSummary(db, { orgId: "org", projectId: null });
    expect(stepsOf(calls[1], "eq")).toEqual([["org_id", "org"]]);
    expect(all.ok && [all.data[0]?.projectId, all.data[0]?.measuredCount]).toEqual(["", 0]);
  });

  it("lists every metric for a project, an empty one as Unmeasured", async () => {
    const { metrics } = await catalog();
    const rows = projectMetricRows(
      metrics,
      [
        row({ metricCode: "positive_sentiment", measuredCount: 1, measuredBase: 72 }),
        row({ projectId: "p2" }),
      ],
      "p1",
    );
    expect(rows.map((r) => [r.metric.code, r.row.measuredBase, r.row.measuredCount])).toEqual([
      ["waste_generated", null, 0],
      ["earned_media_reach", null, 0],
      ["positive_sentiment", 72, 1],
    ]);
  });

  it("rolls the outcomes up per project", () => {
    expect(
      rollupByProject([
        row({ objectiveId: "o1", outcome: "Met" }),
        row({ objectiveId: "o2", outcome: "Unmeasured" }),
        row({ metricCode: "energy_used" }),
        row({ projectId: "p2", objectiveId: "o3", outcome: "Incomplete" }),
      ]),
    ).toEqual([
      {
        projectId: "p1",
        objectives: 2,
        outcomes: { Met: 1, "Not Met": 0, Incomplete: 0, Unmeasured: 1 },
      },
      {
        projectId: "p2",
        objectives: 1,
        outcomes: { Met: 0, "Not Met": 0, Incomplete: 1, Unmeasured: 0 },
      },
    ]);
  });

  it("rolls the figures up per metric: a total, a mean of latest figures, and blank when nothing was measured", async () => {
    const { metrics } = await catalog();
    const rollup = rollupByMetric(metrics as MeasurementMetric[], [
      row({ measuredCount: 2, measuredBase: 1500 }),
      row({ projectId: "p2", measuredCount: 1, unmeasuredCount: 1, measuredBase: 500 }),
      row({ projectId: "p3", objectiveId: "o9" }),
      row({
        metricCode: "positive_sentiment",
        aggregation: "Latest",
        measuredCount: 1,
        measuredBase: 70,
      }),
      row({
        metricCode: "positive_sentiment",
        projectId: "p2",
        aggregation: "Latest",
        measuredCount: 3,
        measuredBase: 80,
      }),
    ]);
    expect(rollup).toEqual([
      {
        metricCode: "waste_generated",
        value: 2000,
        projectsMeasured: 2,
        projectsUnmeasured: 1,
        projectsPartial: 1,
      },
      {
        metricCode: "earned_media_reach",
        value: null,
        projectsMeasured: 0,
        projectsUnmeasured: 0,
        projectsPartial: 0,
      },
      {
        metricCode: "positive_sentiment",
        value: 75,
        projectsMeasured: 2,
        projectsUnmeasured: 0,
        projectsPartial: 0,
      },
    ]);
  });
});

describe("ticketing reference", () => {
  it("sums the imported shows, keeping unreported scans apart and nothing imported null", async () => {
    const { db, calls } = moduleClient({
      "from:project_attendance_totals": [
        {
          data: [
            { tickets_sold: 1800, tickets_scanned: 1650, scans_unreported_count: 0 },
            { tickets_sold: 210, tickets_scanned: null, scans_unreported_count: 1 },
          ],
          error: null,
        },
        {
          data: [{ tickets_sold: 10, tickets_scanned: null, scans_unreported_count: 2 }],
          error: null,
        },
        { data: [], error: null },
        down,
      ],
    });
    expect(await ticketingAttendance(db, "p1")).toEqual({
      ok: true,
      data: { sold: 2010, scanned: 1650, scansUnreported: 1 },
    });
    expect(stepsOf(calls[0], "eq")).toEqual([["project_id", "p1"]]);
    expect(await ticketingAttendance(db, "p1")).toEqual({
      ok: true,
      data: { sold: 10, scanned: null, scansUnreported: 2 },
    });
    expect(await ticketingAttendance(db, "p1")).toEqual({ ok: true, data: null });
    expect((await ticketingAttendance(db, "p1")).ok).toBe(false);
  });
});
