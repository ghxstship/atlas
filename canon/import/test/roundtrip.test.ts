import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkLedger,
  localDatabaseUrl,
  parseLedger,
  readLedger,
  roundTripReport,
  ruledChecksum,
} from "../src/ledger.ts";
import { sheetChecksum } from "../src/manifest.ts";
import { readColumnMap } from "../src/playbook/column-map.ts";
import type { ColumnMap } from "../src/playbook/column-map.ts";
import { normalized, playbookViews, sheetViews, viewsMigration } from "../src/playbook/views.ts";
import { compareWorkbooks, writeExport } from "../src/roundtrip.ts";
import type { CellDiff } from "../src/roundtrip.ts";
import { readWorkbook, sheetByName } from "../src/workbook.ts";
import { PATHS, tempDir, writeFixture } from "./helpers.ts";
import { readFileSync } from "node:fs";

const map: ColumnMap = readColumnMap(
  readFileSync(join(PATHS.canonMap, "playbook-columns.yaml"), "utf8"),
);

describe("export views", () => {
  it("defines a sheet view and an export view for every sheet, ordered by dependency", () => {
    const views = playbookViews(map);
    const names = views.map((v) => v.name);
    expect(names).toContain("v_playbook_cover_page");
    expect(names.filter((n) => n.startsWith("v_playbook_"))).toHaveLength(map.sheets.length);
    for (const v of views)
      for (const d of v.deps) expect(names.indexOf(d)).toBeLessThan(names.indexOf(v.name));
    expect(viewsMigration(map)).toContain("create view xpms.v_sheet_projects");
    expect(normalized("money", "r.x")).toBe("xpms.pb_num((r.x)::numeric)");
    expect(normalized(undefined, "r.x")).toBe("xpms.pb_text((r.x)::text)");
  });

  it("refuses a missing query, an unknown dependency and a cycle", () => {
    const projects = map.sheets.find((s) => s.sheet === "Projects");
    const teams = map.sheets.find((s) => s.sheet === "Teams");
    if (!projects || !teams) throw new Error("map lacks sheets");
    expect(() => sheetViews({ ...teams, query: undefined } as never)).toThrow(
      /needs an export query/,
    );
    const lonely = { version: 1, sheets: [projects] };
    expect(() => playbookViews(lonely)).toThrow(/which no sheet defines/);
    const a = { ...teams, key: "a", query: "select 1 from xpms.v_sheet_b" };
    const b = { ...teams, key: "b", query: "select 1 from xpms.v_sheet_a" };
    expect(() => playbookViews({ version: 1, sheets: [a, b] })).toThrow(/View cycle/);
  });
});

describe("ledger", () => {
  const diff: CellDiff = {
    sheet: "S",
    row: 3,
    column: "B",
    header: "H",
    source: "1.5x",
    database: "1.5",
  };
  const ledger = parseLedger(
    [
      "cells:",
      "  - { sheet: S, cell: B3, ruling: D14, source: 1.5x, database: '1.5', reason: Multipliers are numbers. }",
      "  - { sheet: S, cell: C9, ruling: D13, source: a, database: b, reason: Gone. }",
      "removed_rows:",
      "  - { sheet: S, row: 7, ruling: D16, reason: Retired. }",
    ].join("\n"),
  );

  it("explains ruled cells and removed rows and reports stale entries", () => {
    const removed: CellDiff = { ...diff, row: 7, column: "A", source: "x", database: "" };
    const stray: CellDiff = { ...diff, row: 4 };
    const check = checkLedger([diff, removed, stray], ledger);
    expect(check.unexplained).toEqual([stray]);
    expect(check.stale).toEqual([{ sheet: "S", cell: "C9" }]);
    const report = roundTripReport([diff, stray], check);
    expect(report).toContain("| S | B4 | H | 1.5x | 1.5 | no |");
    expect(report).toContain("| S | B3 | H | 1.5x | 1.5 | ruling |");
  });

  it("refuses unknown rulings and missing reasons", () => {
    expect(() =>
      parseLedger(
        "cells:\n  - { sheet: S, cell: A1, ruling: D99, source: a, database: b, reason: x }",
      ),
    ).toThrow(/unknown ruling/);
    expect(() => parseLedger("removed_rows:\n  - { sheet: S, row: 2, ruling: D16 }")).toThrow(
      /no reason/,
    );
    expect(parseLedger("")).toEqual({ cells: [], removed_rows: [] });
  });

  it("reads the committed ledger and the local database port", () => {
    const committed = readLedger(PATHS);
    expect(committed.cells.length).toBeGreaterThan(0);
    for (const e of committed.cells) expect(e.reason.length).toBeGreaterThan(0);
    expect(localDatabaseUrl(PATHS)).toMatch(
      /^postgresql:\/\/postgres:postgres@127\.0\.0\.1:[0-9]+\/postgres$/,
    );
    expect(readLedger({ ...PATHS, canonMap: tempDir() })).toEqual({ cells: [], removed_rows: [] });
  });

  it("applies the ledger to the source checksum", async () => {
    const path = join(tempDir(), "s.xlsx");
    await writeFixture(path, {
      Projects: [
        ["A", "B"],
        ["x", "1.5x"],
        ["y", "z"],
      ],
    });
    const sheet = sheetByName(await readWorkbook(path), "Projects");
    const empty = { cells: [], removed_rows: [] };
    expect(ruledChecksum(sheet, empty)).toBe(sheetChecksum(sheet));
    const ruled = {
      cells: [
        {
          sheet: "Projects",
          cell: "B2",
          ruling: "D14",
          source: "1.5x",
          database: "1.5",
          reason: "r",
        },
      ],
      removed_rows: [{ sheet: "Projects", row: 3, ruling: "D16", reason: "r" }],
    };
    expect(ruledChecksum(sheet, ruled)).not.toBe(sheetChecksum(sheet));
  });
});

describe("round-trip comparison", () => {
  it("writes an export workbook and finds every differing cell", async () => {
    const dir = tempDir();
    const source = join(dir, "source.xlsx");
    await writeFixture(source, {
      Projects: [
        ["ID", "AMOUNT"],
        ["P1", 1800],
        ["P2", { formula: "B2*2", result: 3600 }],
      ],
      "Cover Page": [[], [null, "Title"]],
    });
    const out = join(dir, "export.xlsx");
    await writeExport(
      [
        {
          name: "Projects",
          headers: ["ID", "AMOUNT"],
          rows: [
            { row: 2, cells: ["P1", "1800"] },
            { row: 3, cells: ["P2", "3601"] },
            { row: 4, cells: ["P3", ""] },
          ],
        },
        { name: "Cover Page", headers: ["", ""], rows: [{ row: 2, cells: ["", "Title"] }] },
      ],
      out,
      "Cover Page",
    );
    const diffs = compareWorkbooks(await readWorkbook(source), await readWorkbook(out), [
      "Projects",
      "Cover Page",
    ]);
    expect(diffs).toEqual([
      {
        sheet: "Projects",
        row: 3,
        column: "B",
        header: "AMOUNT",
        source: "3600",
        database: "3601",
      },
      { sheet: "Projects", row: 4, column: "A", header: "ID", source: "", database: "P3" },
    ]);
  });
});
