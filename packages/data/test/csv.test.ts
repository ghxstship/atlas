import { describe, expect, it } from "vitest";
import { csvField, neutralizeFormula } from "../src/csv.ts";
import { toCsv } from "../src/finance.ts";
import { previewCsv } from "../src/report-builder.ts";

// A69-005 (CWE-1236): exports carry text members and external parties typed, and spreadsheets run a
// cell that starts with =, +, -, @, a tab or a carriage return as a formula.
describe("csvField", () => {
  it("neutralizes every formula start with a leading apostrophe", () => {
    for (const value of [
      '=HYPERLINK("https://evil.example","Invoice")',
      "+1+cmd|' /C calc'!A0",
      "-2+3",
      "@SUM(A1:A9)",
      "\t=1+1",
      "\r=1+1",
      "=",
    ]) {
      expect(neutralizeFormula(value), JSON.stringify(value)).toBe(`'${value}`);
    }
  });

  it("keeps plain numbers and ordinary text as they are", () => {
    for (const value of ["-12.50", "+3", "-0.5e3", "1500", "Deck A rental", "", "a=b", " =x"]) {
      expect(neutralizeFormula(value), value).toBe(value);
    }
  });

  it("quotes after neutralizing", () => {
    expect(csvField('=HYPERLINK("x","y")')).toBe(`"'=HYPERLINK(""x"",""y"")"`);
    expect(csvField("x,y")).toBe('"x,y"');
    expect(csvField("plain")).toBe("plain");
  });

  it("protects the finance and report exports", () => {
    const csv = toCsv(["vendor", "amount"], [["=cmd|' /C calc'!A0", "-125.00"]]);
    expect(csv).toBe(`vendor,amount\r\n'=cmd|' /C calc'!A0,-125.00\r\n`);
    const report = previewCsv(
      {
        columns: [{ field: "title", aggregate: "None", type: "text" }],
        rows: [{ group: "@risk", cells: [{ kind: "value", value: "+SUM(1,2)" }] }],
      } as unknown as Parameters<typeof previewCsv>[0],
      ["Title"],
      "Group",
    );
    expect(report).toBe(`Group,Title\n'@risk,"'+SUM(1,2)"\n`);
  });
});
