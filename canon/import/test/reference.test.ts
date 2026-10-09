import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { generateCanon, generateOptions, REFERENCE_SEED } from "../src/generate.ts";
import type { GenerateResult } from "../src/generate.ts";
import { loadInputs } from "../src/inputs.ts";
import { applyServiceTokens, multiplier, protocolSteps } from "../src/playbook/reference-model.ts";
import { compareWithReference, parseReferenceSeed, REFERENCE_MAPPERS } from "../src/reference.ts";
import { parseRulings } from "../src/rulings.ts";
import { PATHS } from "./helpers.ts";

let result: GenerateResult;

beforeAll(async () => {
  result = generateCanon(await loadInputs(PATHS), generateOptions(PATHS));
});

describe("reference model", () => {
  it("reproduces every table of the owner's reference seed exactly", () => {
    expect(result.reference.length).toBe(Object.keys(REFERENCE_MAPPERS).length);
    for (const d of result.reference) {
      expect({ table: d.table, missing: d.missing, extra: d.extra }).toEqual({
        table: d.table,
        missing: [],
        extra: [],
      });
    }
  });

  it("reports every Playbook value the rulings change", () => {
    const report = readFileSync(
      join(PATHS.root, "design/xos-design-system/export/canon/migration-report.txt"),
      "utf8",
    );
    for (const line of [
      "Labor Rate Cards LRC-008 9000.50.01 Production Stage Manager: stored GL 5500; derived GL 5900 Expense · Technology.",
      'Labor Rate Cards: 24 rows stored multipliers as text ("1.5x"); all 35 now reference an overtime rule.',
      "Emergency Codes: 84 protocols (14 codes x 6 domains) made global; organization and project columns dropped; 183 steps.",
    ]) {
      expect(report).toContain(line);
      expect(result.report).toContain(line);
    }
  });

  it("parses reference SQL tuples, strings, nulls and booleans", () => {
    const parsed = parseReferenceSeed(
      "INSERT INTO t (a, b, c) VALUES\n  ('it''s', NULL, true),\n  ('x', 1.5, false);",
    );
    expect(parsed).toEqual([
      {
        table: "t",
        columns: ["a", "b", "c"],
        rows: [
          ["it's", null, "true"],
          ["x", "1.5", "false"],
        ],
      },
    ]);
    expect(() => parseReferenceSeed("INSERT INTO t (a) VALUES ('open")).toThrow(/Unterminated/);
    expect(() => parseReferenceSeed("INSERT INTO t (a) VALUES ('a' 'b')")).toThrow(/Unexpected/);
    expect(
      compareWithReference([{ table: "nope", columns: [], rows: [] }], new Map())[0]?.missing,
    ).toEqual(["no importer mapping for this table"]);
    expect(REFERENCE_SEED).toContain("0101_xpms_canon_seed.sql");
  });
});

describe("ruling helpers", () => {
  it("reads multipliers written as numbers or as text", () => {
    expect(multiplier({ kind: "number", text: "1.5" })).toEqual({ value: "1.5", wasText: false });
    expect(multiplier({ kind: "string", text: "2.0x" })).toEqual({ value: "2", wasText: true });
    expect(() => multiplier({ kind: "string", text: "double" })).toThrow(/not a multiplier/);
  });

  it("splits numbered protocol steps and replaces agency names with service tokens", () => {
    expect(protocolSteps("Actions: 1. Call EMS. 2. Clear the area.")).toEqual([
      "Call EMS.",
      "Clear the area.",
    ]);
    expect(() => protocolSteps("Actions: 2. Late.")).toThrow(/out of order/);
    expect(() => protocolSteps("No steps here")).toThrow(/No numbered steps/);
    const tokens: [string, string][] = [
      ["LAPD", "{lawEnforcement}"],
      ["EMS", "{ems}"],
    ];
    expect(applyServiceTokens("Notify LAPD and EMS; EMSA stays.", tokens)).toBe(
      "Notify {lawEnforcement} and {ems}; EMSA stays.",
    );
  });

  it("refuses an incomplete rulings file", () => {
    expect(() => parseRulings("")).toThrow(/empty/);
    expect(() => parseRulings("grades: []\n")).toThrow(/lacks/);
  });
});
