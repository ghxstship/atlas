import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  auditPasses,
  auditSummary,
  evaluateAudit,
  type Allowlist,
  type PnpmAdvisory,
  type PnpmAuditReport,
} from "../src/audit.ts";

function advisory(id: string, module_name: string, severity: string): PnpmAdvisory {
  return {
    github_advisory_id: id,
    module_name,
    severity,
    title: `${module_name} problem`,
    url: `https://github.com/advisories/${id}`,
    findings: [{ version: "1.0.0", paths: [`apps__compass>${module_name}`] }],
  };
}

function reportOf(...advisories: PnpmAdvisory[]): PnpmAuditReport {
  return { advisories: Object.fromEntries(advisories.map((a, i) => [String(i), a])) };
}

const entry = {
  id: "GHSA-86w9-cpqp-85rv",
  package: "node-forge",
  severity: "high",
  reason: "No patched release exists; build tooling only.",
  recorded: "2026-10-19",
  review_by: "2027-01-19",
};

describe("evaluateAudit", () => {
  it("fails on a production advisory of any severity", () => {
    const result = evaluateAudit(
      { production: reportOf(advisory("GHSA-2222-3333-4444", "left-pad", "low")), tree: {} },
      { advisories: [] },
      "2026-10-21",
    );
    expect(result.failures.map((f) => [f.id, f.scope, f.path])).toEqual([
      ["GHSA-2222-3333-4444", "production", "apps/compass > left-pad"],
    ]);
    expect(auditPasses(result)).toBe(false);
  });

  it("fails on critical development advisories and warns on the rest", () => {
    const result = evaluateAudit(
      {
        production: {},
        tree: reportOf(
          advisory("GHSA-2222-3333-4444", "evil", "critical"),
          advisory("GHSA-5555-6666-7777", "minimatch", "high"),
        ),
      },
      { advisories: [] },
      "2026-10-21",
    );
    expect(result.failures.map((f) => f.package)).toEqual(["evil"]);
    expect(result.warnings.map((f) => f.package)).toEqual(["minimatch"]);
  });

  it("counts an advisory in both reports once, as production", () => {
    const a = advisory("GHSA-2222-3333-4444", "braces", "moderate");
    const result = evaluateAudit(
      { production: reportOf(a), tree: reportOf(a) },
      { advisories: [] },
      "2026-10-21",
    );
    expect(result.failures).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);
  });

  it("accepts an allowlisted advisory until its review date, then fails it", () => {
    const reports = {
      production: reportOf(advisory(entry.id, "node-forge", "high")),
      tree: {},
    };
    const allowlist: Allowlist = { advisories: [entry] };
    const before = evaluateAudit(reports, allowlist, "2027-01-19");
    expect(before.accepted.map((f) => f.id)).toEqual([entry.id]);
    expect(auditPasses(before)).toBe(true);
    const after = evaluateAudit(reports, allowlist, "2027-01-20");
    expect(after.expired.map((e) => e.id)).toEqual([entry.id]);
    expect(auditPasses(after)).toBe(false);
    expect(auditSummary(after)).toContain("past their review date");
  });

  it("matches the allowlist by advisory and package", () => {
    const result = evaluateAudit(
      { production: reportOf(advisory(entry.id, "other-package", "high")), tree: {} },
      { advisories: [entry] },
      "2026-10-21",
    );
    expect(result.failures).toHaveLength(1);
    expect(result.stale.map((e) => e.package)).toEqual(["node-forge"]);
  });

  it("refuses malformed allowlist entries", () => {
    const result = evaluateAudit(
      { production: {}, tree: {} },
      {
        advisories: [
          { ...entry, id: "CVE-2026-1" },
          { ...entry, reason: "ok" },
          { ...entry, package: "" },
          { ...entry, recorded: "19 Oct" },
          { ...entry, review_by: "soon" },
        ],
      },
      "2026-10-21",
    );
    expect(result.invalid).toHaveLength(5);
    expect(auditPasses(result)).toBe(false);
  });

  it("treats an unknown severity as critical and an advisory without a GHSA by its npm id", () => {
    const result = evaluateAudit(
      {
        production: {},
        tree: { advisories: { a: { id: 42, module_name: "x", severity: "severe", title: "t" } } },
      },
      { advisories: [] },
      "2026-10-21",
    );
    expect(result.failures.map((f) => [f.id, f.severity, f.path])).toEqual([
      ["npm-42", "critical", ""],
    ]);
  });

  it("summarises every section", () => {
    const result = evaluateAudit(
      {
        production: reportOf(
          advisory("GHSA-2222-3333-4444", "a|b", "low"),
          advisory(entry.id, "node-forge", "high"),
        ),
        tree: reportOf(advisory("GHSA-5555-6666-7777", "c", "moderate")),
      },
      {
        advisories: [
          entry,
          { ...entry, id: "GHSA-8888-9999-cccc", package: "gone" },
          { ...entry, id: "bad" },
        ],
      },
      "2026-10-21",
    );
    const summary = auditSummary(result);
    expect(summary).toContain("## Dependency audit failed");
    expect(summary).toContain("### Failing (1)");
    expect(summary).toContain("a\\|b");
    expect(summary).toContain("### Accepted in infra/security/audit-allowlist.json (1)");
    expect(summary).toContain("### Warnings (1)");
    expect(summary).toContain("### Malformed allowlist entries");
    expect(summary).toContain("(remove them)");
  });
});

describe("infra/security/audit-allowlist.json", () => {
  it("has only well-formed entries with a reason and a review date", () => {
    const allowlist = JSON.parse(
      readFileSync(new URL("../audit-allowlist.json", import.meta.url), "utf8"),
    ) as Allowlist;
    const result = evaluateAudit({ production: {}, tree: {} }, allowlist, "2026-10-21");
    expect(result.invalid).toEqual([]);
    for (const e of allowlist.advisories) expect(e.review_by > e.recorded).toBe(true);
  });
});
