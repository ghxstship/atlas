import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REPORT_SOURCES, STANDARD_REPORTS, standardReportOf } from "../src/report-builder.ts";

/** The standard crew reports and their sources (B9, migration 2987, ADR 0148 decision 5). */

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
    const relation = migration("2987_crew_report_sources.sql");
    for (const source of REPORT_SOURCES) {
      expect(relation).toContain(`when '${source.code}' then '${source.relation}'`);
    }
    for (const code of codes.slice(7)) {
      expect(relation).toMatch(new RegExp(`\\('${code}', '[a-z_.]+', \\d+\\)`));
    }
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

  it("finds a report by code, and nothing for anything else", () => {
    expect(standardReportOf("crew-ratings")?.definition.chart).toBe("Bar");
    expect(standardReportOf("nope")).toBeUndefined();
  });
});
