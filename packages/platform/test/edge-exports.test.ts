import { describe, expect, it } from "vitest";
import { getMessages } from "@xos/i18n";
import { exportFileCopy } from "../edge/exports.ts";
import { reportRunLabels } from "../edge/reports.ts";

const AT = new Date("2026-10-23T18:05:00Z");

describe("export file copy (export-render)", () => {
  it("reads each locale's reporting namespace, with times in the requester's zone", async () => {
    const en = await exportFileCopy("en-US");
    const es = await exportFileCopy("es-US");
    expect(
      en.watermark({ email: "carol@northwind.test", at: AT, timeZone: "America/New_York" }),
    ).toBe("Exported by carol@northwind.test on Oct 23, 2026, 2:05 PM EDT");
    expect(es.watermark({ email: "carol@northwind.test", at: AT, timeZone: "UTC" })).toMatch(
      /^Exportado por carol@northwind\.test el 23 oct 2026, .*UTC$/,
    );
    expect(en.subtitle({ rows: 1234, at: AT, timeZone: "UTC" })).toBe(
      "Exported Oct 23, 2026. Rows: 1,234.",
    );
    expect(en.truncated({ limit: 2000 })).toContain("2,000");
    expect(es.truncated({ limit: 2000 })).toBe(
      getMessages("es-US").reporting.exportFile.truncated.replace("{limit}", "2,000"),
    );
  });

  it("falls back to en-US for a locale XOS does not ship, and to UTC for a zone Intl does not know", async () => {
    const fr = await exportFileCopy("fr-FR");
    expect(fr.watermark({ email: "a@b.test", at: AT, timeZone: "Mars/Olympus_Mons" })).toBe(
      "Exported by a@b.test on Oct 23, 2026, 6:05 PM UTC",
    );
  });
});

describe("report PDF watermark copy (report-run)", () => {
  it("names the person the run is for and the time in UTC", async () => {
    const en = await reportRunLabels("en-US");
    expect(en.watermark?.({ email: "carol@northwind.test", at: AT })).toBe(
      "Prepared for carol@northwind.test on Oct 23, 2026, 6:05 PM UTC",
    );
    const es = await reportRunLabels("es-US");
    expect(es.watermark?.({ email: "carol@northwind.test", at: AT })).toMatch(
      /^Preparado para carol/,
    );
  });
});
