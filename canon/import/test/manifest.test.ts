import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildFileManifest,
  buildPlaybookManifest,
  buildSheetManifest,
  checksumLines,
  sha256,
  sheetChecksum,
  sheetGrid,
  toJson,
  verifyFileManifest,
} from "../src/manifest.ts";
import {
  checkSheetCoverage,
  destinationOf,
  headerRowOf,
  sheetKey,
} from "../src/playbook/layout.ts";
import { SOURCE_FILES, sourceByRole } from "../src/sources.ts";
import { readWorkbook, sheetByName } from "../src/workbook.ts";
import { PATHS, tempDir, writeFixture } from "./helpers.ts";

describe("file manifest", () => {
  it("hashes every registered canon file with its Drive metadata", () => {
    const manifest = buildFileManifest(PATHS.canonSource);
    expect(manifest.files.map((f) => f.file)).toEqual(SOURCE_FILES.map((f) => f.file));
    for (const f of manifest.files) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(f.bytes).toBeGreaterThan(0);
    }
    expect(manifest.files.find((f) => f.role === "playbook")?.drive_modified_time).toBe(
      "2026-10-07T15:36:45.256Z",
    );
    expect(verifyFileManifest(manifest, PATHS.canonSource)).toEqual([]);
  });

  it("reports changed, unrecorded and unregistered files", () => {
    const dir = tempDir();
    for (const s of SOURCE_FILES) copyFileSync(join(PATHS.canonSource, s.file), join(dir, s.file));
    const recorded = buildFileManifest(dir);
    writeFileSync(join(dir, sourceByRole("gl-chart").file), "account_code\n9999\n");
    const [first, ...rest] = recorded.files;
    if (!first) throw new Error("manifest is empty");
    const extra = { ...recorded, files: [...rest, { ...first, file: "Ghost.csv" }] };
    const problems = verifyFileManifest(extra, dir);
    expect(problems.some((p) => p.includes("XOS_4.0_GL_Chart_of_Accounts.csv changed"))).toBe(true);
    expect(problems.some((p) => p.includes("XOS_4.0_Bible.xlsx is not recorded"))).toBe(true);
    expect(problems.some((p) => p.includes("Ghost.csv is recorded but not registered"))).toBe(true);
    expect(() => sourceByRole("nope" as never)).toThrow(/No canon source/);
  });
});

describe("sheet manifest", () => {
  it("records headers, data rows and a checksum over normalized cells", async () => {
    const path = join(tempDir(), "p.xlsx");
    await writeFixture(path, {
      Projects: [
        ["PROJECT ID", "BUDGET"],
        ["P1", 1800.0],
        [],
        ["P2", { formula: "B2*2", result: 3600 }],
      ],
      "Cover Page": [[], [null, "Title"]],
    });
    const wb = await readWorkbook(path);
    const projects = sheetByName(wb, "Projects");
    const grid = sheetGrid(projects);
    expect(grid).toEqual({
      headerRow: 1,
      columnCount: 2,
      headers: ["PROJECT ID", "BUDGET"],
      dataRows: [2, 4],
    });
    const expected = sha256(
      checksumLines(
        ["PROJECT ID", "BUDGET"],
        [
          ["2", "P1", "1800"],
          ["4", "P2", "3600"],
        ],
      ),
    );
    expect(sheetChecksum(projects)).toBe(expected);
    const m = buildSheetManifest(projects);
    expect(m).toMatchObject({
      name: "Projects",
      destination: "production-template",
      header_row: 1,
      data_row_count: 2,
      first_data_row: 2,
      last_data_row: 4,
      formula_cell_count: 1,
      checksum_sha256: expected,
    });
    const cover = buildSheetManifest(sheetByName(wb, "Cover Page"));
    expect(cover).toMatchObject({
      header_row: null,
      data_row_count: 1,
      columns: [
        { letter: "A", header: "" },
        { letter: "B", header: "" },
      ],
    });
    const full = buildPlaybookManifest(wb, "p.xlsx", "abc");
    expect(full.sheets).toHaveLength(2);
    expect(toJson({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });

  it("refuses a data column without a header", async () => {
    const path = join(tempDir(), "q.xlsx");
    await writeFixture(path, { Projects: [["A"], ["x", "orphan"]] });
    const wb = await readWorkbook(path);
    expect(() => buildSheetManifest(sheetByName(wb, "Projects"))).toThrow(/no header/);
  });
});

describe("layout", () => {
  it("assigns every Playbook sheet to one destination", () => {
    expect(destinationOf("Teams")).toBe("canon-mirror");
    expect(destinationOf("Verbiage Library")).toBe("standard-library");
    expect(destinationOf("Work Orders")).toBe("production-template");
    expect(destinationOf("Cover Page")).toBe("template-metadata");
    expect(() => destinationOf("Unknown")).toThrow(/no destination/);
    expect(headerRowOf("Cover Page")).toBeNull();
    expect(headerRowOf("Teams")).toBe(1);
    expect(sheetKey("Categories & URID Master")).toBe("categories_urid_master");
    expect(sheetKey("PO Line Items")).toBe("po_line_items");
    expect(checkSheetCoverage(["Teams", "Extra"])).toContain(
      'Sheet "Extra" is not assigned a destination',
    );
  });

  it("covers the real Playbook exactly", async () => {
    const wb = await readWorkbook(join(PATHS.canonSource, sourceByRole("playbook").file));
    expect(checkSheetCoverage(wb.sheets.map((s) => s.name))).toEqual([]);
  });
});
