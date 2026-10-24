import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  appliesTo,
  canonVocabulary,
  labelMappingRows,
  letters,
  libraryLabel,
  mappingProblems,
  parseDecision25,
  playbookOnlyRow,
  resolveValue,
  staleEntries,
  templateLabelProblems,
} from "../src/decision25.ts";
import type { Decision25 } from "../src/decision25.ts";
import { generateCanon, generateOptions } from "../src/generate.ts";
import type { GenerateResult } from "../src/generate.ts";
import { loadInputs } from "../src/inputs.ts";
import type { LoadedInputs } from "../src/inputs.ts";
import { PATHS } from "./helpers.ts";

/**
 * Owner decision 25 (2026-10-19): the Bible wins on structure, values the Bible lacks are imported and
 * marked as from the Playbook, casing differences follow the Bible, status labels map to the closest
 * existing state. canon:check fails on any difference the decision does not explain.
 */

let inputs: LoadedInputs;
let d25: Decision25;
let result: GenerateResult;

beforeAll(async () => {
  inputs = await loadInputs(PATHS);
  d25 = inputs.rulings.decision_25;
  result = generateCanon(inputs, generateOptions(PATHS));
});

describe("decision 25 rules", () => {
  it("imports a value the Bible lacks and keeps every value the Bible states", () => {
    expect(resolveValue("elements", "amount_minor:base", null, "35000", true)).toMatchObject({
      outcome: "playbook-imported",
      basis: "bible-lacks-value",
      canon: "35000",
    });
    expect(resolveValue("elements", "x", " ", "1", false)).toBeUndefined();
    expect(
      resolveValue("dim_category", "category", "Client sponsorship", "Client Sponsorship", true),
    ).toMatchObject({ outcome: "bible-kept", basis: "casing-or-punctuation" });
    expect(
      resolveValue(
        "dim_category",
        "category",
        "Scope activities",
        "Scope Activities · Executive",
        true,
      ),
    ).toMatchObject({ outcome: "bible-kept", basis: "bible-label", canon: "Scope activities" });
    expect(
      resolveValue("dim_gl_account", "description", "Long. Examples: A.", "Long.", true),
    ).toMatchObject({ outcome: "bible-kept", basis: "bible-states-value" });
    expect(letters("Run / Trip")).toBe("runtrip");
  });

  it("maps library labels by casing, by entry, or defers them", () => {
    const units = new Set(["each", "lump sum"]);
    expect(libraryLabel(d25, "Unit of Measure", "Each", "ENM-070", units)).toMatchObject({
      basis: "casing-or-punctuation",
      canon: "each",
    });
    expect(libraryLabel(d25, "Unit of Measure", "Flat Fee", "ENM-075", units)).toMatchObject({
      basis: "closest-value",
      canon: "lump sum",
    });
    const held: Decision25 = {
      ...d25,
      deferred: [{ sheet: "Enumerations", key: "ENM-071", question: "RRR-66", note: "Held." }],
    };
    expect(libraryLabel(held, "Unit of Measure", "Hour", "ENM-071", units)).toMatchObject({
      outcome: "deferred",
      canon: null,
    });
    expect(libraryLabel(d25, "Unit of Measure", "Hour", "ENM-071", units)).toBeUndefined();
    expect(libraryLabel(d25, "Unit of Measure", "Fortnight", "ENM-999", units)).toBeUndefined();
    expect(playbookOnlyRow(d25, "Counterparty Types", "Tenant")).toBeUndefined();
  });

  it("refuses an incomplete decision file", () => {
    expect(() => parseDecision25("")).toThrow(/empty/);
    expect(() => parseDecision25("decision: D25\n")).toThrow(/lacks/);
  });

  it("reports entries nothing uses and mappings to values canon does not hold", () => {
    const none = {
      rows: new Set<string>(),
      library: new Set<string>(),
      deferred: new Set<string>(),
    };
    expect(staleEntries(d25, none)).toHaveLength(
      d25.playbook_only_rows.length + d25.library_labels.length + d25.deferred.length,
    );
    const vocabulary = new Map([["state", new Set(["Active"])]]);
    expect(
      mappingProblems(
        [
          {
            source_list: "x",
            playbook_label: "Open",
            target_domain: "state",
            canon_value: "Opened",
          },
          {
            source_list: "x",
            playbook_label: "Open",
            target_domain: "state",
            canon_value: "Active",
          },
          { source_list: "x", playbook_label: "Hour", target_domain: "unit", canon_value: null },
        ],
        vocabulary,
      ),
    ).toEqual(["Decision 25 maps x Open to Opened, which is not a canon state"]);
    const first = d25.template_labels.slice(0, 1);
    expect(() => labelMappingRows({ ...d25, template_labels: [...first, ...first] }, [])).toThrow(
      /twice/,
    );
  });

  it("checks template labels against the columns they name", () => {
    const map = generateOptions(PATHS).map;
    expect(appliesTo(map, "Crew Shifts STATUS")).toEqual([
      { sheet: "Crew Shifts", ordinal: expect.any(Number) as number },
    ]);
    expect(() => appliesTo(map, "Crew Shifts NO SUCH COLUMN")).toThrow(/names no Playbook column/);
    const extra: Decision25 = {
      ...d25,
      template_labels: [
        ...d25.template_labels.filter((t) => t.applies_to !== "Crew Shifts STATUS"),
        {
          domain: "shift_state",
          label: "Rostered",
          canon_value: "Published",
          basis: "closest-state",
          applies_to: "Crew Shifts STATUS",
        },
      ],
    };
    expect(templateLabelProblems(extra, map, result.tables)).toEqual([
      "Decision 25 entry no longer matches a difference: template_labels Crew Shifts STATUS Rostered",
      'Crew Shifts STATUS holds "Confirmed", which decision 25 does not map',
    ]);
  });
});

describe("decision 25 applied to canon", () => {
  it("explains every Playbook to Bible difference", () => {
    expect(result.unresolved).toEqual([]);
    expect(result.decisionProblems).toEqual([]);
    const outcomes: Record<string, number> = {};
    for (const d of result.diff) {
      const k = d.resolution?.outcome ?? "unexplained";
      outcomes[k] = (outcomes[k] ?? 0) + 1;
    }
    // Decision 39 settled the five differences decision 25 deferred and rules on the 100 default phases.
    expect(outcomes).toEqual({
      "bible-kept": 237,
      "playbook-imported": 2575,
      "mapped-to-existing": 33,
      ruled: 103,
    });
  });

  it("imports Playbook prices the Item Catalog leaves unpriced, each marked as Playbook-sourced", () => {
    const sourced = result.tables.get("playbook_sourced_value") ?? [];
    const prices = sourced.filter((s) => s["target_table"] === "element_price_bands");
    expect(prices).toHaveLength(2570);
    const bands = result.tables.get("element_price_bands") ?? [];
    const deposit = bands.find(
      (b) => b["element_id"] === "0000.51.01-XOS-004" && b["grade_code"] === "base",
    );
    expect(deposit?.["amount_minor"]).toBe("3500000");
    for (const p of prices) {
      const [grade] = String(p["target_column"]).split(":").slice(1);
      expect(
        bands.some((b) => b["element_id"] === p["target_key"] && b["grade_code"] === grade),
      ).toBe(true);
    }
    const centers = result.tables.get("dim_cost_center_template") ?? [];
    expect(centers.find((c) => c["cost_center_id"] === "CC-VENUE")?.["scope_code"]).toBe(
      "CC-VENUE",
    );
    expect(sourced.filter((s) => s["target_table"] === "dim_cost_center_template")).toHaveLength(5);
  });

  it("keeps the Bible's prices where both files price an item", () => {
    const bands = result.tables.get("element_price_bands") ?? [];
    const truss = bands.find(
      (b) => b["element_id"] === "6000.08.02-XPMS-002" && b["grade_code"] === "base",
    );
    expect(truss?.["amount_minor"]).toBe("17000");
  });

  it("maps every label into a value canon holds", () => {
    const rows = result.tables.get("label_mapping") ?? [];
    expect(rows.length).toBe(
      30 + 5 - 3 + d25.playbook_only_rows.length + d25.template_labels.length,
    );
    expect(mappingProblems(rows, canonVocabulary(result.tables))).toEqual([]);
    expect(rows.filter((r) => r["basis"] === "deferred")).toEqual([]);
    expect(
      rows
        .filter((r) => r["playbook_label"] === "Hour" || r["playbook_label"] === "Week")
        .map((r) => [r["playbook_label"], r["canon_value"], r["basis"]]),
    ).toEqual([
      ["Hour", "hour", "casing-or-punctuation"],
      ["Week", "week", "casing-or-punctuation"],
    ]);
  });

  it("maps app lifecycle labels into states the domain schema defines", () => {
    const types = readFileSync(
      fileURLToPath(new URL("../../../packages/data/src/database.types.ts", import.meta.url)),
      "utf8",
    );
    const enums = types.indexOf("\n    Enums: {", types.indexOf("\n  app: {"));
    const enumValues = (name: string): string[] => {
      const at = types.indexOf(`\n      ${name}:`, enums);
      if (at < 0) return [];
      return [...types.slice(at, types.indexOf(";", at)).matchAll(/"([^"]+)"/g)].map(
        (x) => x[1] as string,
      );
    };
    for (const t of d25.template_labels) {
      if (!t.domain.endsWith("_state") || t.domain === "state") continue;
      expect(enumValues(t.domain), `${t.domain} ${t.canon_value}`).toContain(t.canon_value);
    }
  });

  it("leaves the decision file where the importer reads it", () => {
    expect(readFileSync(join(PATHS.root, "canon", "rulings", "decision-25.yaml"), "utf8")).toMatch(
      /decision: D25/,
    );
  });
});
