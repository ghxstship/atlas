import { beforeAll, describe, expect, it } from "vitest";
import { Findings } from "../src/doctrine.ts";
import {
  RulingUse,
  parseDecision39,
  rulingEntries,
  ruledPhase,
  staleRulings,
  unitDimension,
} from "../src/decision39.ts";
import type { Decision39 } from "../src/decision39.ts";
import { generateCanon, generateOptions } from "../src/generate.ts";
import type { GenerateResult } from "../src/generate.ts";
import { loadInputs } from "../src/inputs.ts";
import type { LoadedInputs } from "../src/inputs.ts";
import { buildCanonModel } from "../src/model/bible-model.ts";
import type { Rulings } from "../src/rulings.ts";
import { PATHS } from "./helpers.ts";

/**
 * Owner decision 39 (2026-10-23, RRR-66): the seven canon rulings of finding A56-001 and the declared gaps
 * of finding A65-019, applied by the importer. canon:check fails on an entry that no longer matches.
 */

let inputs: LoadedInputs;
let d39: Decision39;
let result: GenerateResult;

beforeAll(async () => {
  inputs = await loadInputs(PATHS);
  d39 = inputs.rulings.decision_39;
  result = generateCanon(inputs, generateOptions(PATHS));
});

const rows = (t: string) => result.tables.get(t) ?? [];

function modelWith(change: Partial<Decision39>) {
  const findings = new Findings();
  const rulings: Rulings = { ...inputs.rulings, decision_39: { ...d39, ...change } };
  const model = buildCanonModel(
    {
      bible: inputs.bible,
      itemCatalog: inputs.itemCatalog,
      rulings,
      glChart: inputs.glChart,
      files: inputs.sha,
    },
    findings,
  );
  return { model, findings };
}

describe("decision 39 file", () => {
  it("refuses an incomplete decision file", () => {
    expect(() => parseDecision39("")).toThrow(/empty/);
    expect(() => parseDecision39("decision: D39\n")).toThrow(/lacks/);
  });

  it("names the phase each phase name means", () => {
    expect(ruledPhase(d39, "Show")?.phase_code).toBe("OPR");
    expect(ruledPhase(d39, "Procurement")?.phase_code).toBe("PRC");
    expect(ruledPhase(d39, "Operate")).toBeUndefined();
    expect(ruledPhase(d39, null)).toBeUndefined();
  });

  it("reports every entry nothing applied", () => {
    expect(staleRulings(d39, new RulingUse())).toHaveLength(rulingEntries(d39).length);
    expect(staleRulings(d39, new RulingUse(), ["role_codes"])).toHaveLength(
      rulingEntries(d39).length - d39.role_codes.library_only.length,
    );
  });
});

describe("decision 39 applied to canon", () => {
  it("leaves no difference unexplained and no entry stale", () => {
    expect(result.unresolved).toEqual([]);
    expect(result.decisionProblems).toEqual([]);
    expect(result.diff.filter((d) => d.resolution?.outcome === "deferred")).toEqual([]);
  });

  it("gives the touchpoints and items named Show or Procurement their phase", () => {
    const intake = rows("intake").filter(
      (i) => i["source_column"] === "default_phase" || i["source_column"] === "lifecycle_gate",
    );
    expect(intake).toHaveLength(118);
    const bridge = rows("bridge_element_phase");
    expect(bridge).toHaveLength(1211);
    for (const i of intake) {
      expect(i["intake_state"]).toBe("Complete");
      const phase = i["proposed_value"] === "Show" ? "OPR" : "PRC";
      expect(i["canon_value"]).toBe(phase);
      if (i["source_column"] === "default_phase")
        expect(bridge.find((b) => b["element_id"] === i["target_key"])?.["phase_code"]).toBe(phase);
      else
        expect(
          rows("dim_touchpoint").find((t) => t["touchpoint_id"] === i["target_key"])?.[
            "lifecycle_phase_code"
          ],
        ).toBe("OPR");
    }
    expect(rows("dim_touchpoint").filter((t) => t["lifecycle_phase_code"] === null)).toEqual([]);
  });

  it("keeps the Playbook's phase names in intake so the round trip reproduces them", () => {
    const playbook = rows("intake").filter(
      (i) => i["source_sheet"] === "Procurement Catalog" && i["source_column"] === "DEFAULT PHASE",
    );
    expect(playbook).toHaveLength(100);
    for (const i of playbook) expect(i["intake_state"]).toBe("Canceled");
    const ruled = result.diff.filter((d) => d.resolution?.basis === "owner-ruling");
    expect(ruled.filter((d) => d.sheet === "Procurement Catalog")).toHaveLength(100);
    expect(ruled.filter((d) => d.sheet === "Roles Library").map((d) => d.key)).toEqual([
      ...d39.role_codes.library_only,
    ]);
  });

  it("removes the empty statements and keeps every other row in its place", () => {
    expect(rows("canon_statement").filter((s) => String(s["tab"]).startsWith("23"))).toEqual([]);
    const budget = rows("dim_budget_template_rule");
    expect(budget.map((r) => r["field"])).not.toContain("Estimate");
    expect(budget).toHaveLength(10);
    expect(budget.find((r) => r["field"] === "Contingency")?.["ordinal"]).toBe("9");
  });

  it("ratifies the time dimension so Hour and Week resolve", () => {
    expect(rows("dim_unit_dimension")).toEqual([{ dimension_code: "time", name: "Time" }]);
    const aliases = rows("dim_unit_alias");
    for (const u of ["hour", "day", "week", "year"])
      expect(aliases.find((a) => a["alias"] === u)?.["dimension_code"]).toBe("time");
    expect(aliases.find((a) => a["alias"] === "each")?.["dimension_code"]).toBeNull();
    expect(unitDimension(d39, "lot")).toBeNull();
  });

  it("declares the gaps of the phases with no Active element, and only those", () => {
    const gaps = rows("declared_gap");
    expect(gaps.map((g) => g["phase_code"])).toEqual(["SCP", "ENG", "AMP", "CLS"]);
    for (const g of gaps) {
      expect(g["decision"]).toBe("D39");
      expect(g["ratified_on"]).toBe("2026-10-23");
    }
  });

  it("settles every conflict and structure finding the rulings cover", () => {
    const { findings, model } = modelWith({});
    expect(model.problems).toEqual([]);
    expect(findings.ofKind("conflict")).toEqual([]);
    expect(findings.ofKind("structure")).toEqual([]);
    expect(findings.ofKind("ruling").map((f) => f.location)).toContain("Item Catalog department");
  });

  it("stops on an entry the canon files no longer match", () => {
    const { model } = modelWith({
      item_department_labels: [
        { stated: "4000 Environment", label: "6000 Operations", items: ["6000.01.01-XOS-999"] },
      ],
      declared_gaps: { ratified_by: "Owner", phases: [{ phase_code: "OPR", reason: "None." }] },
    });
    expect(model.problems).toContain(
      "Decision 39 entry no longer matches the canon files: item_department_labels 6000.01.01-XOS-999",
    );
    expect(model.problems).toContain(
      "Phase SCP has no Active element and no declared gap (doctrine 3.4); decision 39 declares none for it",
    );
    expect(model.problems).toContain(
      "Decision 39 entry no longer matches the canon files: declared_gaps OPR",
    );
  });
});
