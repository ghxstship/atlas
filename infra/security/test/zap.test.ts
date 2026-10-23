import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateZap, parseZapRules, zapSummary, type ZapReport } from "../src/zap.ts";

const RULES = [
  "# comment",
  "",
  "10020\tFAIL\t(Missing Anti-clickjacking Header)\tThe proxy sends X-Frame-Options DENY.",
  "10027\tIGNORE\t(Information Disclosure - Suspicious Comments)\tWords inside minified framework bundles.",
  "10096\tWARN\t(Timestamp Disclosure - Unix)\t",
].join("\n");

function alert(pluginid: string, riskcode: string, extra: Record<string, unknown> = {}) {
  return {
    pluginid,
    name: `Rule ${pluginid}`,
    riskcode,
    confidence: "2",
    count: "2",
    instances: [{ uri: `https://atlas-staging.example.test/${pluginid}` }],
    ...extra,
  };
}

const report = (...alerts: ReturnType<typeof alert>[]): ZapReport => ({
  site: [{ "@name": "https://atlas-staging.example.test", alerts }],
});

describe("parseZapRules", () => {
  it("reads ids, actions, names and reasons", () => {
    const rules = parseZapRules(RULES);
    expect([...rules.keys()]).toEqual(["10020", "10027", "10096"]);
    expect(rules.get("10027")).toEqual({
      id: "10027",
      action: "IGNORE",
      name: "Information Disclosure - Suspicious Comments",
      note: "Words inside minified framework bundles.",
    });
  });

  it("refuses an ignored rule without a reason, unknown actions, bad ids and duplicates", () => {
    expect(() => parseZapRules("10027\tIGNORE\t(Comments)")).toThrow(/without a reason/);
    expect(() => parseZapRules("10027\tSKIP\t(Comments)\tbecause")).toThrow(/unknown action/);
    expect(() => parseZapRules("abc\tWARN\t(x)")).toThrow(/not a number/);
    expect(() => parseZapRules("1\tWARN\t(x)\n1\tFAIL\t(x)")).toThrow(/listed twice/);
  });

  it("accepts the committed rules file", () => {
    const text = readFileSync(new URL("../zap/baseline-rules.tsv", import.meta.url), "utf8");
    const rules = parseZapRules(text);
    expect(rules.get("10020")?.action).toBe("FAIL");
    expect(rules.get("10038")?.action).toBe("FAIL");
    for (const rule of rules.values()) expect(rule.note.length).toBeGreaterThan(20);
  });
});

describe("evaluateZap", () => {
  const rules = parseZapRules(RULES);

  it("fails on a FAIL rule and on any High alert that is not ignored", () => {
    const verdict = evaluateZap(
      report(alert("10020", "2"), alert("40012", "3"), alert("10027", "3")),
      rules,
    );
    expect(verdict.failures.map((a) => [a.pluginId, a.risk])).toEqual([
      ["10020", "Medium"],
      ["40012", "High"],
    ]);
    expect(verdict.ignored.map((a) => a.pluginId)).toEqual(["10027"]);
  });

  it("warns on Low and Medium alerts and drops false positives and unlisted informational ones", () => {
    const verdict = evaluateZap(
      report(
        alert("10096", "1"),
        alert("10063", "2"),
        alert("10109", "0"),
        alert("10021", "3", { confidence: "0" }),
      ),
      rules,
    );
    expect(verdict.failures).toEqual([]);
    expect(verdict.warnings.map((a) => a.pluginId)).toEqual(["10096", "10063", "10109"]);
  });

  it("summarises failures, warnings and accepted alerts", () => {
    const verdict = evaluateZap(
      report(alert("10020", "2"), alert("10096", "1"), alert("10027", "0")),
      rules,
    );
    const summary = zapSummary("https://atlas-staging.example.test", verdict);
    expect(summary).toContain("failed");
    expect(summary).toContain("### Failing");
    expect(summary).toContain("### Warnings");
    expect(summary).toContain("Words inside minified framework bundles.");
    expect(zapSummary("x", { failures: [], warnings: [], ignored: [] })).toContain("passed");
  });

  it("reads reports without names, counts or instances", () => {
    const verdict = evaluateZap(
      { site: [{ alerts: [{ pluginid: "10020", riskcode: "9", alert: "Clickjacking" }] }, {}] },
      rules,
    );
    expect(verdict.failures).toEqual([
      {
        site: "",
        pluginId: "10020",
        name: "Clickjacking",
        risk: "High",
        count: 1,
        example: "",
        note: "The proxy sends X-Frame-Options DENY.",
      },
    ]);
    expect(evaluateZap({}, rules).failures).toEqual([]);
  });
});
