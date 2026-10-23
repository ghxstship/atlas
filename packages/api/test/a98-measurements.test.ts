/**
 * Contract tests for project measurement (A98, RRR-143, migrations 1550 and 1551): the metric, unit and tag catalog,
 * gate 1 objectives, figures with their write-only correction reason and the correction ledger, earned media coverage
 * and the measurement summary. Requests run through `contractApp` against the in-memory client, and every success is
 * checked against openapi/v1.json with `expectContract`. Refusals the guards raise come back as 422 with their rule.
 */
import { describe, expect, it } from "vitest";
import { handlers as projects } from "../src/handlers/projects.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, refusal, requests, success, tenantRow } from "./support/memory-db.ts";
import type { Row } from "./support/memory-db.ts";

const ORG = testContext().org?.id as string;
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(98000 + n).padStart(12, "0")}`;
const PROJECT = id(1);
type Page = { data: Row[] };

describe("Projects: the measurement catalog", () => {
  it("lists the metrics with their canon benchmark, the units and the sustainability tags in order", async () => {
    const db = memoryDb({
      measurement_metrics: [
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
      ],
      measurement_units: [
        {
          unit_code: "lb",
          dimension: "Mass",
          factor_to_base: 0.45359237,
          unit_system: "Imperial",
          is_display: true,
          ordinal: 3,
        },
        {
          unit_code: "kg",
          dimension: "Mass",
          factor_to_base: 1,
          unit_system: "Metric",
          is_display: true,
          ordinal: 1,
        },
      ],
      measurement_metric_tags: [
        { metric_code: "waste_generated", tag_id: "TAG-020", tag: "RECYCLABLE" },
        { metric_code: "waste_generated", tag_id: "TAG-005", tag: "REUSABLE" },
      ],
    });
    const http = requests(contractApp({ handlers: [projects], db }));
    const metrics = (await expectContract(
      await success(http.get("/measurement-metrics")),
      "measurementMetrics.list",
    )) as Page;
    expect(metrics.data.map((m) => m["metric_code"])).toEqual([
      "waste_generated",
      "positive_sentiment",
    ]);
    expect(metrics.data[0]).toMatchObject({
      canon_value_numeric: 2.4,
      canon_qualifier: "MODELED event avg",
    });
    const units = (await expectContract(
      await success(http.get("/measurement-units?filter[dimension][eq]=Mass")),
      "measurementUnits.list",
    )) as Page;
    expect(units.data.map((u) => [u["unit_code"], u["factor_to_base"]])).toEqual([
      ["kg", 1],
      ["lb", 0.45359237],
    ]);
    const tags = (await expectContract(
      await success(http.get("/measurement-metric-tags")),
      "measurementMetricTags.list",
    )) as Page;
    expect(tags.data.map((t) => t["tag"])).toEqual(["REUSABLE", "RECYCLABLE"]);
  });
});

describe("Projects: gate 1 objectives", () => {
  it("lists, reads, sets, changes and withdraws an objective, and reports the gate 1 lock", async () => {
    const db = memoryDb({
      project_objectives: [
        tenantRow(id(10), ORG, {
          project_id: PROJECT,
          metric_code: "attendance",
          direction: "At Least",
          target_value: 5000,
          unit_code: "count",
          note: null,
        }),
      ],
    });
    const http = requests(contractApp({ handlers: [projects], db }));
    const page = (await expectContract(
      await success(http.get(`/project-objectives?filter[project_id][eq]=${PROJECT}`)),
      "projectObjectives.list",
    )) as Page;
    expect(page.data.map((o) => o["metric_code"])).toEqual(["attendance"]);
    await expectContract(
      await success(http.get(`/project-objectives/${id(10)}`)),
      "projectObjectives.get",
    );
    const response1 = await success(
      http.post("/project-objectives", {
        project_id: PROJECT,
        metric_code: "waste_generated",
        direction: "At Most",
        target_value: 2,
        unit_code: "t",
      }),
    );
    const made = (await expectContract(response1, "projectObjectives.create")) as Row;
    expect(made).toMatchObject({ metric_code: "waste_generated", target_value: 2, org_id: ORG });
    const response2 = await success(
      http.patch(`/project-objectives/${id(10)}`, { target_value: 5500 }),
    );
    const changed = (await expectContract(response2, "projectObjectives.update")) as Row;
    expect(changed["target_value"]).toBe(5500);
    // The metric never changes: the update body does not carry it.
    const response3 = await success(
      http.patch(`/project-objectives/${id(10)}`, { metric_code: "online_audience" }),
    );
    const kept = (await expectContract(response3, "projectObjectives.update")) as Row;
    expect(kept["metric_code"]).toBe("attendance");
    db.fail(
      "project_objectives",
      refusal(
        "project_objectives_locked",
        "Gate 1 has been passed: only a gate approver sets, changes or withdraws the objectives it recorded.",
      ),
    );
    const locked = await http.patch(`/project-objectives/${id(10)}`, { target_value: 4000 });
    expect(locked.status).toBe(422);
    expect(await locked.json()).toMatchObject({ rule: "project_objectives_locked" });
    const gone = await http.delete(`/project-objectives/${id(10)}`);
    expect(gone.status).toBe(204);
    await expectContract(gone, "projectObjectives.delete");
    expect((await http.get(`/project-objectives/${id(10)}`)).status).toBe(404);
  });
});

describe("Projects: figures and their corrections", () => {
  it("records a figure or an unmeasured one, corrects with a write-only reason, and withdraws", async () => {
    const db = memoryDb(
      {
        project_measurements: [
          tenantRow(id(20), ORG, {
            project_id: PROJECT,
            metric_code: "waste_generated",
            measured_on: "2026-10-18",
            value: 1200,
            unit_code: "kg",
            source: "Import",
            source_reference: "Hauler invoice 4471",
            source_uri: null,
            note: null,
            correction_reason: null,
          }),
        ],
        project_measurement_corrections: [
          tenantRow(id(21), ORG, {
            project_measurement_id: id(20),
            correction_kind: "Corrected",
            previous_value: 1200,
            previous_unit_code: "kg",
            previous_measured_on: "2026-10-18",
            value: 1.25,
            unit_code: "t",
            measured_on: "2026-10-18",
            reason: "Weighbridge ticket supersedes the estimate.",
          }),
        ],
      },
      {},
      {
        project_measurements: {
          source: "Manual",
          measured_on: "2026-10-21",
          correction_reason: null,
        },
      },
    );
    const http = requests(contractApp({ handlers: [projects], db }));
    const page = (await expectContract(
      await success(http.get(`/project-measurements?filter[project_id][eq]=${PROJECT}`)),
      "projectMeasurements.list",
    )) as Page;
    expect(page.data[0]).not.toHaveProperty("correction_reason");
    await expectContract(
      await success(http.get(`/project-measurements/${id(20)}`)),
      "projectMeasurements.get",
    );

    const response4 = await success(
      http.post("/project-measurements", {
        project_id: PROJECT,
        metric_code: "water_used",
        value: null,
        unit_code: null,
      }),
    );
    const unmeasured = (await expectContract(response4, "projectMeasurements.create")) as Row;
    expect(unmeasured["value"]).toBeNull();
    expect(db.writes.at(-1)?.values).toMatchObject({ value: null, unit_code: null });

    db.fail(
      "project_measurements",
      refusal("measurement_correction_reason", "Say why the figure is corrected."),
    );
    const noReason = await http.patch(`/project-measurements/${id(20)}`, { value: 1250 });
    expect(noReason.status).toBe(422);
    expect(await noReason.json()).toMatchObject({ rule: "measurement_correction_reason" });

    const response5 = await success(
      http.patch(`/project-measurements/${id(20)}`, {
        value: 1.25,
        unit_code: "t",
        correction_reason: "Weighbridge ticket supersedes the estimate.",
      }),
    );
    const corrected = (await expectContract(response5, "projectMeasurements.update")) as Row;
    expect(corrected).toMatchObject({ value: 1.25, unit_code: "t" });
    expect(corrected).not.toHaveProperty("correction_reason");
    expect(db.writes.at(-1)?.values).toMatchObject({
      correction_reason: "Weighbridge ticket supersedes the estimate.",
    });
    // The source never changes: the update body does not carry it.
    const response6 = await success(
      http.patch(`/project-measurements/${id(20)}`, { source: "Manual", note: "Two roll-offs." }),
    );
    const sourced = (await expectContract(response6, "projectMeasurements.update")) as Row;
    expect(sourced).toMatchObject({ source: "Import", note: "Two roll-offs." });

    const response7 = await success(
      http.get(`/project-measurement-corrections?filter[project_measurement_id][eq]=${id(20)}`),
    );
    const ledger = (await expectContract(response7, "projectMeasurementCorrections.list")) as Page;
    expect(ledger.data.map((c) => [c["correction_kind"], c["previous_value"], c["value"]])).toEqual(
      [["Corrected", 1200, 1.25]],
    );
    await expectContract(
      await success(http.get(`/project-measurement-corrections/${id(21)}`)),
      "projectMeasurementCorrections.get",
    );
    expect((await http.post("/project-measurement-corrections", {})).status).toBe(404);

    const gone = await http.delete(`/project-measurements/${id(20)}`);
    expect(gone.status).toBe(204);
    await expectContract(gone, "projectMeasurements.delete");
  });
});

describe("Projects: earned media coverage", () => {
  it("lists, reads, records, rates and withdraws coverage, refusing a future date", async () => {
    const db = memoryDb(
      {
        earned_media_items: [
          tenantRow(id(30), ORG, {
            project_id: PROJECT,
            title: "Weekend picks",
            outlet: "WLRN",
            medium: "Broadcast",
            published_on: "2026-10-17",
            url: "https://radio.example.test/weekend",
            reach: null,
            tone: null,
            source: "Import",
            source_reference: "monitoring-export.csv",
            note: null,
          }),
        ],
      },
      {},
      { earned_media_items: { source: "Manual" } },
    );
    const http = requests(contractApp({ handlers: [projects], db }));
    const page = (await expectContract(
      await success(http.get(`/earned-media-items?filter[project_id][eq]=${PROJECT}`)),
      "earnedMediaItems.list",
    )) as Page;
    expect(page.data[0]).toMatchObject({ reach: null, tone: null });
    await expectContract(
      await success(http.get(`/earned-media-items/${id(30)}`)),
      "earnedMediaItems.get",
    );
    const response8 = await success(
      http.post("/earned-media-items", {
        project_id: PROJECT,
        title: "Summer Series opens on the pier",
        outlet: "Miami Herald",
        medium: "Online",
        published_on: "2026-10-18",
        url: "https://news.example.test/summer-series",
        reach: 120000,
        tone: "Positive",
      }),
    );
    const made = (await expectContract(response8, "earnedMediaItems.create")) as Row;
    expect(made).toMatchObject({ reach: 120000, tone: "Positive" });
    const response9 = await success(
      http.patch(`/earned-media-items/${id(30)}`, { tone: "Neutral", reach: 45000 }),
    );
    const rated = (await expectContract(response9, "earnedMediaItems.update")) as Row;
    expect(rated).toMatchObject({ tone: "Neutral", reach: 45000 });
    db.fail(
      "earned_media_items",
      refusal(
        "earned_media_in_future",
        "Coverage runs on or before today on the project's calendar.",
      ),
    );
    const future = await http.post("/earned-media-items", {
      project_id: PROJECT,
      title: "Tomorrow's paper",
      outlet: "Miami Herald",
      medium: "Print",
      published_on: "2099-01-01",
    });
    expect(future.status).toBe(422);
    const gone = await http.delete(`/earned-media-items/${id(30)}`);
    expect(gone.status).toBe(204);
    await expectContract(gone, "earnedMediaItems.delete");
  });
});

describe("Projects: measurement summary", () => {
  it("lists objectives against figures with an unmeasured figure null, never zero", async () => {
    const row = (metric: string, extra: Row) => ({
      org_id: ORG,
      project_id: PROJECT,
      metric_code: metric,
      family: "Sustainability",
      dimension: "Mass",
      base_unit_code: "kg",
      aggregation: "Sum",
      objective_id: null,
      direction: null,
      target_value: null,
      target_unit_code: null,
      target_base: null,
      measured_count: 0,
      unmeasured_count: 0,
      measured_base: null,
      last_measured_on: null,
      outcome: null,
      ...extra,
    });
    const db = memoryDb({
      project_measurement_summary: [
        row("waste_generated", {
          objective_id: id(40),
          direction: "At Most",
          target_value: 2,
          target_unit_code: "t",
          target_base: 2000,
          measured_count: 2,
          measured_base: 1953.59237,
          last_measured_on: "2026-10-18",
          outcome: "Met",
        }),
        row("water_used", {
          dimension: "Volume",
          base_unit_code: "l",
          objective_id: id(41),
          direction: "At Most",
          target_value: 50,
          target_unit_code: "m3",
          target_base: 50000,
          unmeasured_count: 1,
          outcome: "Unmeasured",
        }),
      ],
    });
    const http = requests(contractApp({ handlers: [projects], db }));
    const page = (await expectContract(
      await success(http.get(`/project-measurement-summary?filter[project_id][eq]=${PROJECT}`)),
      "projectMeasurementSummary.list",
    )) as Page;
    expect(page.data.map((r) => [r["metric_code"], r["measured_base"], r["outcome"]])).toEqual([
      ["waste_generated", 1953.59237, "Met"],
      ["water_used", null, "Unmeasured"],
    ]);
  });
});
