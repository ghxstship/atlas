import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  certifiedPayrollCsv,
  certifiedPayrollModel,
  weekDates,
} from "../../src/certified-payroll.ts";
import { csvField } from "../../src/csv.ts";
import { renderDocumentPdf } from "../../src/documents/render.ts";
import {
  OSHA_300_COLUMNS,
  osha300Csv,
  osha300Model,
  osha300aCsv,
  osha300aModel,
  osha301Model,
} from "../../src/osha.ts";
import { BRAND, NOW } from "./fixtures.ts";
import { CASES, ESTABLISHMENT, PAYROLL, SUMMARY, TOTALS } from "./compliance-fixtures.ts";

/** The OSHA Forms 300, 300A and 301 and the WH-347 (A82, migrations 1385 and 1386, ADR 0041). */
const messages = (locale: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`../../../i18n/messages/${locale}/documents.json`, import.meta.url),
      "utf8",
    ),
  );
const ctx = (locale = "en-US") => ({
  locale,
  messages: messages(locale),
  brand: BRAND,
  recordUrl: "https://atlas.example.test/northwind/forms",
  watermark: "Downloaded by viewer@example.test on Oct 21, 2026",
  now: NOW,
});

function texts(model: { blocks: readonly unknown[] }): string {
  return JSON.stringify(model.blocks);
}

describe("OSHA Form 300", () => {
  it("prints privacy case in place of the name and neutralizes the CSV", () => {
    const csv = osha300Csv(CASES);
    const [header, first, second] = csv.trimEnd().split("\r\n");
    expect(header).toBe(OSHA_300_COLUMNS.map(csvField).join(","));
    expect(first).toContain("001,Frank Adeyemi,Rigger,2026-03-10");
    expect(first).toContain(",X,,,4,2,X,,,,,");
    expect(second).toContain("002,privacy case,Stagehand");
    expect(csv).not.toContain("HYPERLINK");
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("builds the log with its totals row and the attention note, in Spanish too", () => {
    const model = osha300Model(ESTABLISHMENT, 2026, CASES, ctx());
    expect(model.kind).toBe("osha-300");
    expect(model.watermark?.text).toContain("viewer@example.test");
    const table = model.blocks.find((b) => b.kind === "table");
    expect(table && "footer" in table ? table.footer?.[0] : null).toEqual([
      "Page totals",
      "",
      "",
      "",
      "",
      "",
      "0",
      "1",
      "0",
      "1",
      "4",
      "2",
      "1",
      "0",
      "0",
      "0",
      "0",
      "1",
    ]);
    expect(texts(model)).toContain("privacy case");
    expect(texts(model)).not.toContain("HYPERLINK");
    const es = osha300Model(ESTABLISHMENT, 2026, CASES, ctx("es-US"));
    expect(es.title).toContain("Formulario 300 de OSHA");
    expect(texts(es)).toContain("caso de privacidad");
  });
});

describe("OSHA Forms 300A and 301", () => {
  it("summarizes the year and keeps the certification", () => {
    const model = osha300aModel(ESTABLISHMENT, 2026, TOTALS, SUMMARY, ctx());
    const body = texts(model);
    expect(body).toContain("(H) Total number of cases with days away from work");
    expect(body).toContain("66,400");
    expect(body).toContain("Post this Summary page from February 1 to April 30");
    const csv = osha300aCsv(ESTABLISHMENT, 2026, TOTALS, SUMMARY);
    expect(csv.split("\r\n")[1]).toContain("2026,Northwind Shop,100 Harbor Way,Miami,FL,33132");
  });

  it("reports one case with every numbered item", () => {
    const model = osha301Model(ESTABLISHMENT, CASES[0] as (typeof CASES)[number], ctx());
    const body = texts(model);
    for (let item = 1; item <= 18; item += 1) expect(body).toContain(`"${item}) `);
    expect(body).toContain("Bayfront Urgent Care");
    expect(model.facts.recordKey).toBe("OSHA 301 2026-001");
  });
});

describe("WH-347", () => {
  it("lists the seven dates of the week ending on the date", () => {
    expect(weekDates("2026-06-14")).toEqual([
      "2026-06-08",
      "2026-06-09",
      "2026-06-10",
      "2026-06-11",
      "2026-06-12",
      "2026-06-13",
      "2026-06-14",
    ]);
  });

  it("writes every WH-347 column, empty where XOS holds nothing", () => {
    const [header, first] = certifiedPayrollCsv(PAYROLL).trimEnd().split("\r\n");
    const columns = (header ?? "").split(",");
    expect(columns).toContain("(1E) Worker identifying no.");
    expect(columns).toContain("(8) FICA");
    expect(columns).toContain("(9) Net pay for all work");
    expect(columns.filter((c) => c.startsWith("(4) ")).length).toBe(14);
    const cells = (first ?? "").split(",");
    expect(cells.slice(cells.length - 11)).toEqual([
      "32.00",
      "48.00",
      "",
      "",
      "1760.00",
      "1760.00",
      "",
      "",
      "",
      "",
      "",
    ]);
  });

  it("prints straight and overtime rows per worker and the Statement of Compliance", () => {
    const model = certifiedPayrollModel(PAYROLL, { ...ctx(), certifyingOfficial: "Alice Morgan" });
    const table = model.blocks.find((b) => b.kind === "table");
    expect(table && "rows" in table ? table.rows.length : 0).toBe(4);
    const body = texts(model);
    expect(body).toContain("RA 2");
    expect(body).toContain("Statement of Compliance");
    expect(body).toContain("29 CFR part 3");
    expect(body).toContain("come from the payroll provider");
    expect(model.facts.recordKey).toBe("WH-347 No. 3, week ending 2026-06-14");
  });

  it("renders tagged PDFs with the watermark", async () => {
    const bytes = await renderDocumentPdf(
      certifiedPayrollModel(PAYROLL, { ...ctx(), certifyingOfficial: "Alice Morgan" }),
      { paper: "letter", orientation: "landscape" },
    );
    const pdf = Buffer.from(bytes).toString("latin1");
    expect(pdf.startsWith("%PDF-1.7")).toBe(true);
    expect(pdf).toContain("<pdf:Keywords>Downloaded by viewer@example.test");
  }, 60_000);
});
