import * as lucide from "lucide-react";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  departmentCodes,
  departmentIcon,
  glyphIconNames,
  iconLibrary,
  isDepartmentCode,
  isPhaseCode,
  isRecordKind,
  isRecordState,
  phaseCodes,
  phaseIcon,
  recordKindIcon,
  recordKinds,
  recordStates,
  stateGlyph,
} from "../src/index.ts";

const installed = (
  createRequire(import.meta.url)("lucide-react/package.json") as { version: string }
).version;
const exports = lucide as unknown as Record<string, unknown>;

describe("glyph map", () => {
  it("is drawn with the pinned lucide-react at a 1.5 stroke", () => {
    expect(installed).toBe("1.53.0");
    expect(iconLibrary).toEqual({
      name: "lucide-react",
      version: installed,
      license: "ISC",
      strokeWidth: 1.5,
    });
  });

  it("covers the 10 departments, 9 phases, 26 record kinds and 9 record states", () => {
    expect(departmentCodes).toHaveLength(10);
    expect(phaseCodes).toEqual(["SCP", "ENG", "ADV", "PRC", "BLD", "INS", "OPR", "AMP", "CLS"]);
    expect(recordKinds).toHaveLength(26);
    expect(recordStates).toEqual([
      "proposed",
      "ready",
      "scheduled",
      "active",
      "blocked",
      "in-review",
      "complete",
      "deferred",
      "canceled",
    ]);
  });

  it("resolves every glyph name to a lucide-react 1.53.0 component export", () => {
    const missing = glyphIconNames.filter((name) => {
      const component = exports[name];
      return typeof component !== "object" && typeof component !== "function";
    });
    expect(missing).toEqual([]);
    expect(glyphIconNames).toHaveLength(45);
  });

  it("returns the mapped icon for each accessor", () => {
    expect(departmentIcon("4000")).toBe("Tent");
    expect(departmentIcon("0000")).toBe("Briefcase");
    expect(phaseIcon("BLD")).toBe("Hammer");
    expect(recordKindIcon("Task")).toBe("SquareCheck");
    expect(stateGlyph("blocked")).toBe("octagon");
  });

  it("narrows strings to canon codes", () => {
    expect(isDepartmentCode("9000")).toBe(true);
    expect(isDepartmentCode("9100")).toBe(false);
    expect(isPhaseCode("CLS")).toBe(true);
    expect(isPhaseCode("toString")).toBe(false);
    expect(isRecordKind("Shift")).toBe(true);
    expect(isRecordKind("shift")).toBe(false);
    expect(isRecordState("in-review")).toBe(true);
    expect(isRecordState("Cancelled")).toBe(false);
  });
});
