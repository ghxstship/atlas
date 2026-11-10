import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  advisorsSummary,
  advisorsUrl,
  cliAdvisorLints,
  evaluateAdvisors,
  fetchAdvisors,
  type AcceptedLint,
  type Lint,
} from "../src/advisors.ts";

const REF = "abcdefghijklmnopqrst";

const lint = (name: string, level: string, cache_key = `${name}_app_table`): Lint => ({
  name,
  title: name.replaceAll("_", " "),
  level,
  detail: `Detail of ${name} | with a pipe`,
  remediation: `https://supabase.com/docs/guides/database/database-linter?lint=${name}`,
  cache_key,
});

describe("advisorsUrl", () => {
  it("builds the Management API URL and refuses anything but a project ref", () => {
    expect(advisorsUrl(REF, "security")).toBe(
      `https://api.supabase.com/v1/projects/${REF}/advisors/security`,
    );
    expect(() => advisorsUrl("https://evil.example", "security")).toThrow(
      /not a Supabase project ref/,
    );
  });
});

describe("evaluateAdvisors", () => {
  it("fails on WARN and ERROR, reports INFO, and honors accepted lints with a reason", () => {
    const accepted: AcceptedLint[] = [
      {
        name: "auth_leaked_password_protection",
        reason: "Staging branch only; production has it on (runbook step 7).",
        recorded: "2026-10-21",
      },
      { name: "function_search_path_mutable", reason: "too short", recorded: "2026-10-21" },
      {
        name: "multiple_permissive_policies",
        match: "app_orders",
        reason: "Two read paths on one table, measured in the RLS benchmark.",
        recorded: "2026-10-21",
      },
    ];
    const verdict = evaluateAdvisors(
      [
        {
          kind: "security",
          lints: [
            lint("auth_leaked_password_protection", "WARN"),
            lint("function_search_path_mutable", "WARN"),
            lint("rls_disabled_in_public", "ERROR"),
            lint("rls_enabled_no_policy", "INFO"),
          ],
        },
        {
          kind: "performance",
          lints: [
            lint("multiple_permissive_policies", "WARN", "multiple_permissive_policies_app_orders"),
            lint("multiple_permissive_policies", "WARN", "multiple_permissive_policies_app_people"),
            lint("unused_index", "info"),
            { name: "odd", level: "FATAL" },
          ],
        },
      ],
      accepted,
    );
    expect(verdict.failures.map((f) => [f.kind, f.name, f.level])).toEqual([
      ["security", "function_search_path_mutable", "WARN"],
      ["security", "rls_disabled_in_public", "ERROR"],
      ["performance", "multiple_permissive_policies", "WARN"],
      ["performance", "odd", "ERROR"],
    ]);
    expect(verdict.accepted.map((f) => f.name)).toEqual([
      "auth_leaked_password_protection",
      "multiple_permissive_policies",
    ]);
    expect(verdict.info).toHaveLength(2);

    const summary = advisorsSummary(REF, verdict);
    expect(summary).toContain("failed");
    expect(summary).toContain("\\| with a pipe");
    expect(summary).toContain("### Accepted in infra/security/advisors-accepted.json");
    expect(advisorsSummary(REF, { failures: [], accepted: [], info: [] })).toContain("passed");
  });
});

describe("fetchAdvisors", () => {
  it("asks for both kinds with the bearer token", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
      return new Response(
        JSON.stringify(url.endsWith("security") ? { lints: [lint("x", "WARN")] } : {}),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const results = await fetchAdvisors(REF, "token-value", fake);
    expect(results.map((r) => [r.kind, r.lints.length])).toEqual([
      ["security", 1],
      ["performance", 0],
    ]);
    expect(calls.every((c) => c.auth === "Bearer token-value")).toBe(true);
  });

  it("fails on an error status without echoing the token", async () => {
    const fake = (async () => new Response("no", { status: 401 })) as typeof fetch;
    await expect(fetchAdvisors(REF, "token-value", fake)).rejects.toThrow(/answered 401/);
    await expect(fetchAdvisors(REF, "token-value", fake)).rejects.not.toThrow(/token-value/);
  });
});

describe("cliAdvisorLints (the local stack, Supabase CLI 3)", () => {
  const report = {
    results: [
      {
        name: "security_definer_view",
        title: "Security Definer View",
        level: "ERROR",
        categories: ["SECURITY"],
        detail: "View `app.email_templates` is defined with the SECURITY DEFINER property",
        remediation:
          "https://supabase.com/docs/guides/database/database-linter?lint=0010_security_definer_view",
        cacheKey: "security_definer_view_app_email_templates",
      },
      {
        name: "unindexed_foreign_keys",
        level: "WARN",
        categories: ["PERFORMANCE"],
        cacheKey: "fk_x",
      },
    ],
  };

  it("maps the CLI's report to the Management API's lints, cacheKey to cache_key", () => {
    const [security, performance] = cliAdvisorLints(report);
    expect(security?.kind).toBe("security");
    expect(security?.lints[0]?.cache_key).toBe("security_definer_view_app_email_templates");
    expect(performance?.lints.map((l) => l.name)).toEqual(["unindexed_foreign_keys"]);
  });

  it("judges it against the accepted list like staging's", () => {
    const accepted: AcceptedLint[] = [
      {
        name: "security_definer_view",
        match: "_app_",
        reason: "Reference catalogs read as their owner by design.",
        recorded: "2026-11-10",
      },
    ];
    const verdict = evaluateAdvisors(cliAdvisorLints(report), accepted);
    expect(verdict.accepted.map((f) => f.name)).toEqual(["security_definer_view"]);
    expect(verdict.failures.map((f) => f.name)).toEqual(["unindexed_foreign_keys"]);
  });

  it("refuses a report without results", () => {
    expect(() => cliAdvisorLints({ message: "error" })).toThrow(/no results/);
  });
});

describe("infra/security/advisors-accepted.json", () => {
  it("gives every accepted lint a reason and a date", () => {
    const file = JSON.parse(
      readFileSync(new URL("../advisors-accepted.json", import.meta.url), "utf8"),
    ) as { accepted: AcceptedLint[] };
    for (const entry of file.accepted) {
      expect(entry.reason.length).toBeGreaterThanOrEqual(20);
      expect(entry.recorded).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
