import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { Findings } from "../src/doctrine.ts";
import { loadInputs } from "../src/inputs.ts";
import type { LoadedInputs } from "../src/inputs.ts";
import { buildCanonModel } from "../src/model/bible-model.ts";
import {
  columnKey,
  dispositionTotals,
  inferType,
  mergeColumnMap,
  readColumnMap,
  skeletonSheet,
  validateColumnMap,
  writeColumnMap,
} from "../src/playbook/column-map.ts";
import type { ColumnMap } from "../src/playbook/column-map.ts";
import { MIRRORS, mirrorFor } from "../src/playbook/mirror.ts";
import { TEMPLATE_CODE, applyPlaybook } from "../src/playbook/model.ts";
import type { PlaybookResult } from "../src/playbook/model.ts";
import {
  PLAYBOOK_TABLES,
  stdColumnName,
  stdTableSpec,
  stdTableSpecs,
} from "../src/playbook/tables.ts";
import { sheetByName } from "../src/workbook.ts";
import { PATHS } from "./helpers.ts";

let inputs: LoadedInputs;
let map: ColumnMap;
let result: PlaybookResult;

beforeAll(async () => {
  inputs = await loadInputs(PATHS);
  map = readColumnMap(readFileSync(join(PATHS.canonMap, "playbook-columns.yaml"), "utf8"));
  const findings = new Findings();
  const model = buildCanonModel(
    {
      bible: inputs.bible,
      itemCatalog: inputs.itemCatalog,
      glChart: inputs.glChart,
      files: inputs.sha,
    },
    findings,
  );
  result = applyPlaybook(
    model.tables,
    model.intake,
    inputs.playbook,
    map,
    findings,
    inputs.sha.playbook,
  );
});

describe("column map", () => {
  it("derives stable keys and types", () => {
    expect(columnKey("PROGRESS (%)", "U", new Set())).toBe("progress_pct");
    expect(columnKey("LOCATION / ZONE", "H", new Set())).toBe("location_zone");
    expect(columnKey("JOB TITLE", "E", new Set(["job_title"]))).toBe("job_title_e");
    expect(columnKey("", "B", new Set())).toBe("column_b");
    expect(columnKey("1ST CALL", "C", new Set())).toBe("c_1st_call");
    expect(inferType(new Set(["empty"]))).toBe("text");
    expect(inferType(new Set(["number", "empty"]))).toBe("numeric");
    expect(inferType(new Set(["boolean"]))).toBe("bool");
    expect(inferType(new Set(["date"]))).toBe("date");
    expect(inferType(new Set(["date", "datetime"]))).toBe("timestamp");
    expect(inferType(new Set(["time"]))).toBe("time");
    expect(inferType(new Set(["string", "number"]))).toBe("text");
  });

  it("covers every column of every sheet and keeps completed entries on merge", () => {
    expect(map.sheets).toHaveLength(inputs.playbook.sheets.length);
    const merged = mergeColumnMap(map, inputs.playbook);
    expect(merged.sheets.map((s) => s.columns.length)).toEqual(
      map.sheets.map((s) => s.columns.length),
    );
    expect(readColumnMap(writeColumnMap(merged)).sheets).toHaveLength(merged.sheets.length);
    const totals = dispositionTotals(merged);
    expect(totals.field + totals.computed + totals.presentation).toBe(
      merged.sheets.reduce((n, s) => n + s.columns.length, 0),
    );
    expect(() => readColumnMap("version: 1\n")).toThrow(/no sheets/);
  });

  it("refuses a stale header and reports incomplete entries", () => {
    const projects = sheetByName(inputs.playbook, "Projects");
    const sk = skeletonSheet(projects);
    const changed: ColumnMap = {
      version: 1,
      sheets: [
        { ...sk, columns: sk.columns.map((c, i) => (i === 0 ? { ...c, header: "OLD" } : c)) },
      ],
    };
    expect(() => mergeColumnMap(changed, inputs.playbook)).toThrow(/header changed/);
    const problems = validateColumnMap({ version: 1, sheets: [sk] }, inputs.playbook);
    expect(problems.some((p) => p.includes("computed column has no SQL"))).toBe(true);
    expect(problems.some((p) => p.includes("is not in the column map"))).toBe(true);
    const cover = skeletonSheet(sheetByName(inputs.playbook, "Cover Page"));
    expect(
      cover.columns.every((c) => c.target === "xpms.production_template_metadata.value_text"),
    ).toBe(true);
  });
});

describe("Playbook model", () => {
  it("defines Standard Library tables from the column map", () => {
    const specs = stdTableSpecs(map);
    expect(specs.map((s) => s.name).sort()).toEqual([
      "std_document_library",
      "std_emergency_code",
      "std_enumeration",
      "std_labor_rate_card",
      "std_radio_channel",
      "std_role",
      "std_sop",
      "std_vendor_class",
      "std_vendor_entitlement",
      "std_verbiage",
    ]);
    expect(stdColumnName("rate", "money")).toBe("rate_minor");
    expect(() =>
      stdTableSpec({ ...skeletonSheet(sheetByName(inputs.playbook, "Projects")) }),
    ).toThrow(/not a Standard Library sheet/);
    expect(PLAYBOOK_TABLES.map((t) => t.name)).toContain("production_template_values");
  });

  it("loads every template row and keeps the template private", () => {
    expect(result.tables.get("production_template")?.[0]).toMatchObject({
      template_code: TEMPLATE_CODE,
      is_published: false,
    });
    const rows = result.tables.get("production_template_rows") ?? [];
    expect(rows.filter((r) => r["sheet_name"] === "Budget Expenses")).toHaveLength(205);
    expect((result.tables.get("production_template_metadata") ?? []).length).toBeGreaterThan(0);
    expect((result.tables.get("playbook_sheet") ?? []).length).toBe(46);
  });

  it("cross-checks mirrored sheets and holds every difference in intake", () => {
    expect(MIRRORS).toHaveLength(8);
    expect(mirrorFor("Teams").table).toBe("dim_team");
    expect(() => mirrorFor("Projects")).toThrow(/No mirror/);
    const values = result.diff.filter((d) => d.kind === "value");
    for (const d of values) {
      expect(
        result.intake.some(
          (i) =>
            i.source_sheet === d.sheet &&
            i.source_row === String(d.row) &&
            i.source_column === d.column,
        ),
      ).toBe(true);
    }
    expect(result.diff.some((d) => d.kind === "playbook-only-row" && d.key === "Landlord")).toBe(
      true,
    );
    const dept = (result.tables.get("dim_department") ?? []).find((d) => d["dept_code"] === "4000");
    expect(dept?.["source_row"]).toBe("6");
    expect(dept?.["executive_lead"]).toBeTruthy();
  });
});
