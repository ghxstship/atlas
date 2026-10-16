import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkInventory,
  definedProperties,
  exportedNames,
  findRawValues,
  findUnknownTokens,
  tokenUsage,
} from "../src/design-audit.ts";
import { runDesignAudit } from "../src/design-audit-repo.ts";
import { specComponents } from "../src/inventory.ts";

describe("findRawValues", () => {
  it("reports raw colors, arbitrary lengths, durations and inline lengths with their lines", () => {
    const source = [
      `const a = "#1c1d21";`,
      `<div className="w-[13px] bg-[#fff] duration-[150ms] p-(--space-8)" />`,
      `<div style={{ width: "40px" }} />`,
      `const c = "rgba(0, 0, 0, 0.5)";`,
    ].join("\n");
    const findings = findRawValues("x.tsx", source);
    expect(findings.map((f) => [f.line, f.rule, f.text])).toEqual([
      [1, "raw-color", "#1c1d21"],
      [2, "raw-color", "#fff"],
      [4, "raw-color", "rgba(0"],
      [2, "raw-length", "w-[13px]"],
      [2, "raw-duration", "duration-[150ms]"],
      [3, "raw-length", `width: "40px"`],
    ]);
  });

  it("accepts token classes and lines that opt out with a reason", () => {
    const source = [
      `<div className="min-w-(--layout-reading) text-text-13 grid-cols-[auto_1fr]" />`,
      `// design-audit-allow: the org's brand color is data`,
      `const brand = "#ff0066";`,
    ].join("\n");
    expect(findRawValues("y.tsx", source)).toEqual([]);
  });
});

describe("token usage", () => {
  it("collects definitions from CSS and inline style objects", () => {
    const names = definedProperties(`:root { --space-8: 8px; }\nstyle={{ "--bar-fill": "40%" }}`);
    expect([...names].sort()).toEqual(["--bar-fill", "--space-8"]);
  });

  it("reports references to properties nothing defines", () => {
    const defined = new Set(["--space-8"]);
    const findings = findUnknownTokens(
      "z.css",
      "a { gap: var(--space-8); color: var(--colr-text); }",
      defined,
    );
    expect(findings).toEqual([
      { file: "z.css", line: 1, rule: "unknown-token", text: "--colr-text" },
    ]);
  });

  it("counts references per token", () => {
    const usage = tokenUsage(["var(--a) var(--b)", "var(--a)"]);
    expect(Object.fromEntries(usage)).toEqual({ "--a": 2, "--b": 1 });
  });
});

describe("component inventory", () => {
  it("reads exported names from declarations and export lists, skipping types", () => {
    const names = exportedNames(
      `export function Button() {}\nexport const Card = 1;\nexport { Dialog, type DialogProps, Toast as Toaster } from "./x";`,
    );
    expect([...names].sort()).toEqual(["Button", "Card", "Dialog", "Toaster"]);
  });

  it("splits the spec list into present and missing", () => {
    expect(checkInventory(["Button", "Card"], new Set(["Button"]))).toEqual({
      missing: ["Card"],
      present: ["Button"],
    });
  });

  it("lists each Section 11.4 component once", () => {
    expect(new Set(specComponents).size).toBe(specComponents.length);
    expect(specComponents).toContain("GateReadinessPanel");
  });
});

describe("the repository", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const report = runDesignAudit(root);

  it("has no raw values or unknown tokens in app and library source", () => {
    expect(report.findings).toEqual([]);
    expect(report.files).toBeGreaterThan(100);
  });

  it("exports every Section 11.4 component from @xos/ui", () => {
    expect(report.web.missing).toEqual([]);
  });

  it("ships the Compass field components from @xos/ui-native", () => {
    for (const name of ["ClockButton", "ScanSheet", "OfflineBanner", "QuickIncidentSheet"]) {
      expect(report.native.present).toContain(name);
    }
  });
});
