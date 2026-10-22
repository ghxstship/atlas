import { describe, expect, it } from "vitest";
import { getMessages } from "@xos/i18n";
import { reportDeliveryCopy, reportRunLabels } from "../edge/reports.ts";

describe("report file and email copy (report-run)", () => {
  it("reads each locale's workflow and reporting namespaces on demand", async () => {
    const en = await reportRunLabels("en-US");
    const es = await reportRunLabels("es-US");
    expect(en.unpriced).toBe(getMessages("en-US").reporting.file.unpriced);
    expect(es.unpriced).toBe(getMessages("es-US").reporting.file.unpriced);
    expect(es.truncated).toBe(getMessages("es-US").reporting.file.truncated);
    expect(en.field("unknown_source", "unknown_key")).toBe("unknown_key");
    expect(en.column("unknown_source", "amount", "Sum")).toContain("amount");
    expect(en.subtitle?.({ rows: 3, unpriced: 1, at: new Date("2026-10-20T12:00:00Z") })).toContain(
      "3",
    );
  });

  it("falls back to en-US for a locale XOS does not ship", async () => {
    expect((await reportRunLabels("fr-FR")).unpriced).toBe(
      getMessages("en-US").reporting.file.unpriced,
    );
    const copy = await reportDeliveryCopy("fr-FR");
    const english = await reportDeliveryCopy("en-US");
    expect(copy.subject({ report: "Spend", org: "Acme" })).toBe(
      english.subject({ report: "Spend", org: "Acme" }),
    );
    expect(copy.subject({ report: "Spend", org: "Acme" })).toContain("Spend");
  });
});
