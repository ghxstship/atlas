import { beforeAll, describe, expect, it } from "vitest";
import { COUNT_RULES, countFailures, validateCounts } from "../src/counts.ts";
import { EM_DASH, Findings } from "../src/doctrine.ts";
import { loadInputs } from "../src/inputs.ts";
import type { LoadedInputs } from "../src/inputs.ts";
import { buildCanonModel } from "../src/model/bible-model.ts";
import type { CanonModel } from "../src/model/bible-model.ts";
import { fromMinorUnits, toMinorUnits } from "../src/model/values.ts";
import { PATHS } from "./helpers.ts";

let inputs: LoadedInputs;
let model: CanonModel;
let findings: Findings;

beforeAll(async () => {
  inputs = await loadInputs(PATHS);
  findings = new Findings();
  model = buildCanonModel(
    {
      bible: inputs.bible,
      itemCatalog: inputs.itemCatalog,
      rulings: inputs.rulings,
      glChart: inputs.glChart,
      files: inputs.sha,
    },
    findings,
  );
});

const rows = (t: string) => model.tables.get(t) ?? [];

describe("count validation", () => {
  it("passes for every entity in the real canon files", () => {
    const results = validateCounts(model.counts, model.generated);
    expect(countFailures(results)).toEqual([]);
    expect(results).toHaveLength(COUNT_RULES.length);
    expect(results.find((r) => r.entity === "items")).toMatchObject({ parsed: 1211, stated: 1211 });
  });

  it("fails with a clear message on a mismatch", () => {
    const parsed = new Map(model.counts);
    parsed.set("01", 11);
    const generated = new Map(model.generated);
    generated.set("disciplines", "113");
    const failures = countFailures(validateCounts(parsed, generated));
    expect(failures).toEqual([
      "Count mismatch for departments (source 01): expected 10, parsed 11, the Bible states 10",
      "Count mismatch for disciplines (source 02): expected 114, parsed 114, the Bible states 113",
    ]);
    const missing = new Map(model.counts);
    missing.delete("09");
    expect(() => validateCounts(missing, generated)).toThrow(/No parsed count for source 09/);
  });
});

describe("canon model", () => {
  it("has no hard problems", () => {
    expect(model.problems).toEqual([]);
  });

  it("lists departments in numeric order with 4000 as Environment", () => {
    const depts = rows("dim_department");
    expect(depts.map((d) => d["dept_code"])).toEqual([
      "0000",
      "1000",
      "2000",
      "3000",
      "4000",
      "5000",
      "6000",
      "7000",
      "8000",
      "9000",
    ]);
    expect(depts.find((d) => d["dept_code"] === "4000")?.["department"]).toBe("Environment");
  });

  it("reads gates 1 to 3 as Scope, Engage and Advance and supersedes DIS and DSN", () => {
    const phases = rows("dim_phase")
      .slice(0, 3)
      .map((p) => [p["gate"], p["phase_code"], p["phase"]]);
    expect(phases).toEqual([
      ["1", "SCP", "Scope"],
      ["2", "ENG", "Engage"],
      ["3", "ADV", "Advance"],
    ]);
    expect(rows("dim_phase").find((p) => p["phase_code"] === "ADV")?.["is_redefined"]).toBe(true);
    expect(rows("supersession").map((s) => [s["code"], s["successor_code"], s["label"]])).toEqual([
      ["DIS", "SCP", "Discover"],
      ["DSN", "SCP", "Design"],
    ]);
  });

  it("keeps blank prices unpriced and converts amounts to minor units", () => {
    const deposit = rows("element_price_bands").filter(
      (b) => b["element_id"] === "0000.51.01-XOS-004",
    );
    expect(deposit).toEqual([]);
    for (const band of rows("element_price_bands"))
      expect(band["amount_minor"]).toMatch(/^[0-9]+$/);
  });

  it("stores no em dash and reports every substitution", () => {
    for (const [, tableRows] of model.tables) {
      for (const row of tableRows) {
        for (const v of Object.values(row))
          if (typeof v === "string") expect(v.includes(EM_DASH)).toBe(false);
      }
    }
    expect(findings.ofKind("em-dash-substituted").length).toBeGreaterThan(0);
  });

  it("holds unresolved phase names in intake", () => {
    expect(model.intake.length).toBeGreaterThan(0);
    for (const i of model.intake) expect(i.intake_state).toBe("Proposed");
    expect(new Set(model.intake.map((i) => i.proposed_value))).toEqual(
      new Set(["Show", "Procurement"]),
    );
  });
});

describe("minor units", () => {
  it("converts without floating point", () => {
    expect(toMinorUnits("1250.5")).toBe("125050");
    expect(toMinorUnits("0.07")).toBe("7");
    expect(toMinorUnits("35000")).toBe("3500000");
    expect(toMinorUnits("-2.10")).toBe("-210");
    expect(toMinorUnits("0")).toBe("0");
    expect(() => toMinorUnits("1.005")).toThrow(/more than 2 decimals/);
    expect(() => toMinorUnits("abc")).toThrow(/not a decimal/);
    expect(fromMinorUnits("125050")).toBe("1250.5");
    expect(fromMinorUnits("7")).toBe("0.07");
    expect(fromMinorUnits("3500000")).toBe("35000");
    expect(fromMinorUnits("-210")).toBe("-2.1");
    expect(fromMinorUnits("0")).toBe("0");
  });
});
