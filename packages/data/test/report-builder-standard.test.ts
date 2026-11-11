import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planReport, previewReport, REPORT_SOURCES } from "../src/report-builder.ts";
import { STANDARD_REPORTS, standardReportOf } from "../src/report-builder-standard.ts";
import { fakeClient, okResponse } from "./fake-client.ts";

/** The standard crew reports and their sources (B9, migration 6517, ADR 0148 decision 5). */

const migration = (name: string) =>
  readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");

describe("report sources", () => {
  it("holds all eleven codes, custom_object included, matching private.report_sources", () => {
    const codes = REPORT_SOURCES.map((s) => s.code);
    expect(codes).toEqual([
      "records",
      "finance",
      "crew",
      "procurement",
      "assets",
      "incidents",
      "custom_object",
      "crew_hours",
      "crew_responses",
      "crew_removals",
      "crew_ratings",
    ]);
    const relation = migration("6517_crew_report_sources.sql");
    for (const source of REPORT_SOURCES) {
      expect(relation).toContain(`when '${source.code}' then '${source.relation}'`);
    }
    for (const code of codes.slice(7)) {
      expect(relation).toMatch(new RegExp(`\\('${code}', '[a-z_.]+', \\d+\\)`));
    }
  });
});

describe("a source with soft deletes", () => {
  it("previews its live rows only", async () => {
    const { db, calls } = fakeClient({ "from:records": [okResponse([])] });
    await previewReport(db, {
      orgId: "o1",
      projectIds: ["p1"],
      definition: {
        id: null,
        name: "Records",
        sourceCode: "records",
        customObjectTypeId: null,
        shared: false,
        mine: true,
        chart: "Table",
        groupBy: null,
        fields: [{ field: "title", aggregate: "None" }],
        filters: [],
      },
    });
    expect(calls[0]?.steps).toContainEqual(["is", ["deleted_at", null]]);
  });
});

describe("standard reports", () => {
  it("are the five crew reports, each over a field its source has", () => {
    expect(STANDARD_REPORTS.map((r) => r.code)).toEqual([
      "crew-utilization",
      "crew-invitation-responses",
      "crew-removals",
      "crew-ratings",
      "crew-scheduled-vs-actual",
    ]);
    for (const report of STANDARD_REPORTS) {
      const source = REPORT_SOURCES.find((s) => s.code === report.definition.sourceCode);
      const keys = new Set(source?.fields.map((f) => f.key));
      expect(source).toBeDefined();
      for (const field of report.definition.fields) expect(keys).toContain(field.field);
      for (const filter of report.definition.filters) expect(keys).toContain(filter.field);
      if (report.definition.groupBy) expect(keys).toContain(report.definition.groupBy);
      // Unsaved, so saving makes the viewer's own copy.
      expect(report.definition.id).toBeNull();
    }
  });

  it("preview over their views, which have no deleted_at column, with their filters applied", async () => {
    for (const report of STANDARD_REPORTS) {
      const d = report.definition;
      const relation = REPORT_SOURCES.find((s) => s.code === d.sourceCode)?.relation as string;
      const { db, calls } = fakeClient({ [`from:${relation}`]: [okResponse([])] });
      const preview = await previewReport(db, {
        orgId: "o1",
        projectIds: ["p1"],
        definition: d,
      });
      expect(preview.ok).toBe(true);
      const steps = calls[0]?.steps ?? [];
      expect(steps.some(([name]) => name === "is")).toBe(false);
      for (const filter of d.filters) {
        expect(steps).toContainEqual(["eq", [filter.field, filter.value]]);
      }
    }
  });

  it("run with the same filters as they preview: a filter's column is read, never shown", () => {
    for (const report of STANDARD_REPORTS) {
      const plan = planReport(report.definition);
      for (const filter of report.definition.filters) expect(plan?.select).toContain(filter.field);
    }
    const removals = planReport(standardReportOf("crew-removals")?.definition as never);
    expect(removals?.select).toContain("from_state");
    expect(removals?.columns.map((c) => c.field)).toEqual([
      "removed_at",
      "person_name",
      "role_code",
      "reason",
    ]);
  });

  it("finds a report by code, and nothing for anything else", () => {
    expect(standardReportOf("crew-ratings")?.definition.chart).toBe("Bar");
    expect(standardReportOf("nope")).toBeUndefined();
  });
});
