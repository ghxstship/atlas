import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  cellFromValue,
  getCell,
  isPresent,
  lastColumn,
  lastRow,
  readWorkbook,
  rowIsPresent,
  sheetByName,
} from "../src/workbook.ts";
import type { WorkbookData } from "../src/workbook.ts";
import { tempDir, writeFixture } from "./helpers.ts";

let wb: WorkbookData;

beforeAll(async () => {
  const path = join(tempDir(), "fixture.xlsx");
  await writeFixture(
    path,
    {
      Data: [
        ["ID", "AMOUNT", "TOTAL", "WHEN", "NOTE"],
        [
          "A-1",
          2,
          { formula: "B2*2", result: 0 },
          new Date(Date.UTC(2026, 8, 15)),
          { richText: [{ text: "rich " }, { text: "text" }] },
        ],
        [
          "A-2",
          3,
          { formula: "B3*2", result: 6 },
          new Date(Date.UTC(2026, 8, 15, 9, 30)),
          { text: "link", hyperlink: "https://example.org" },
        ],
        [],
        ["A-4", { error: "#N/A" }, { formula: "B5*2" }, null, "  spaced   out "],
      ],
      Merged: [
        ["Title", null, null],
        ["", "x"],
      ],
    },
    (book) => {
      const merged = book.getWorksheet("Merged");
      merged?.mergeCells("A1:C1");
    },
  );
  wb = await readWorkbook(path);
});

describe("readWorkbook", () => {
  it("lists sheets in order with their used ranges", () => {
    expect(wb.sheets.map((s) => s.name)).toEqual(["Data", "Merged"]);
    expect(sheetByName(wb, "Data").index).toBe(1);
    expect(sheetByName(wb, "Data").usedRange).toBe("A1:E5");
    expect(() => sheetByName(wb, "Nope")).toThrow(/no sheet/);
  });

  it("keeps zero formula results and the formula text", () => {
    const data = sheetByName(wb, "Data");
    expect(getCell(data, 2, 3)).toEqual({ kind: "number", text: "0", formula: "=B2*2" });
    expect(getCell(data, 3, 3)).toEqual({ kind: "number", text: "6", formula: "=B3*2" });
    expect(getCell(data, 5, 3)).toEqual({ kind: "empty", text: "", formula: "=B5*2" });
  });

  it("reads dates, rich text, hyperlinks and errors", () => {
    const data = sheetByName(wb, "Data");
    expect(getCell(data, 2, 4)).toEqual({ kind: "date", text: "2026-09-15" });
    expect(getCell(data, 3, 4)).toEqual({ kind: "datetime", text: "2026-09-15T09:30:00" });
    expect(getCell(data, 2, 5)).toEqual({ kind: "string", text: "rich text" });
    expect(getCell(data, 3, 5)).toEqual({ kind: "string", text: "link" });
    expect(getCell(data, 5, 2)).toEqual({ kind: "error", text: "#N/A" });
    expect(getCell(data, 9, 9)).toEqual({ kind: "empty", text: "" });
  });

  it("finds the last row and column and presence", () => {
    const data = sheetByName(wb, "Data");
    expect(lastRow(data)).toBe(5);
    expect(lastColumn(data)).toBe(5);
    expect(lastColumn(data, 5)).toBe(5);
    expect(rowIsPresent(data, 4)).toBe(false);
    expect(rowIsPresent(data, 5)).toBe(true);
    expect(isPresent({ kind: "string", text: "   " })).toBe(false);
    expect(isPresent({ kind: "empty", text: "", formula: "=1" })).toBe(true);
  });

  it("keeps only the anchor of a merged range", () => {
    const merged = sheetByName(wb, "Merged");
    expect(merged.mergedRanges).toEqual(["A1:C1"]);
    expect(getCell(merged, 1, 1).text).toBe("Title");
    expect(getCell(merged, 1, 2).kind).toBe("empty");
    expect(getCell(merged, 2, 2).text).toBe("x");
  });
});

describe("cellFromValue", () => {
  it("handles hyperlink rich text and refuses unknown objects", () => {
    expect(
      cellFromValue({
        text: { richText: [{ text: "a" }, { text: "b" }] },
        hyperlink: "x",
      } as never),
    ).toEqual({
      kind: "string",
      text: "ab",
    });
    expect(cellFromValue({ error: "#REF!" } as never, "=X1")).toEqual({
      kind: "error",
      text: "#REF!",
      formula: "=X1",
    });
    expect(() => cellFromValue({ odd: 1 } as never)).toThrow(TypeError);
  });
});
