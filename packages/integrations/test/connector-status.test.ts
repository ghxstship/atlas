import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OAUTH_PROVIDERS } from "../src/connectors/storage/oauth.ts";
import {
  PROVIDERS,
  SCOPE_CATEGORY,
  SYNC_SCOPES,
  providersIn,
  usesClientCredentials,
  type ProviderEntry,
} from "../src/framework/catalog.ts";

/**
 * docs/integration-connectors.md is the file the marketing site cites for the status of each connector
 * (ghxstship/atlas issue 126). These tests hold its table to the catalog, the plan registry and the en-US names, and
 * its quoted sentences to their files.
 */
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string) => readFileSync(`${repo}${path}`, "utf8");
const doc = read("docs/integration-connectors.md");
const names = JSON.parse(read("packages/i18n/messages/en-US/integrations.json")) as {
  providers: Record<string, string>;
  scopes: Record<string, string>;
};

/** The cells of every body row of the first Markdown table under a heading. */
function tableUnder(text: string, heading: string): string[][] {
  const start = text.indexOf(`\n${heading}\n`);
  expect(start, heading).toBeGreaterThan(-1);
  const lines = text.slice(start + heading.length + 2).split("\n");
  const first = lines.findIndex((line) => line.startsWith("|"));
  const length = lines.slice(first).findIndex((line) => !line.startsWith("|"));
  return lines.slice(first + 2, length === -1 ? undefined : first + length).map((line) =>
    line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim()),
  );
}

/** The plans of plans.yaml in order, each with the features it adds. */
function plansWithFeatures(): { code: string; adds: string[] }[] {
  const text = read("packages/schemas/plans.yaml");
  const blocks = text
    .slice(text.indexOf("\nplans:\n"), text.indexOf("\naddons:\n"))
    .split("\n  - code: ");
  return blocks.slice(1).map((block) => {
    const list = /\n {4}features:\s*\[([^\]]*)\]/.exec(block);
    expect(list, block.slice(0, 20)).not.toBeNull();
    return {
      code: block.slice(0, block.indexOf("\n")).trim(),
      adds: (list?.[1] ?? "")
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean),
    };
  });
}

const title = (code: string) => code.charAt(0).toUpperCase() + code.slice(1);

function planOf(entry: ProviderEntry): string {
  if (entry.requiredFeature === null) return "Every plan";
  const plan = plansWithFeatures().find((p) => p.adds.includes(entry.requiredFeature ?? ""));
  expect(plan, entry.requiredFeature ?? "").toBeDefined();
  return `${title(plan?.code ?? "")} and above`;
}

function whatItDoes(entry: ProviderEntry): string {
  const labels = SYNC_SCOPES.filter((scope) => SCOPE_CATEGORY[scope] === entry.category).map(
    (scope) => names.scopes[scope] ?? "",
  );
  return labels.map((label, i) => (i === 0 ? label : label.toLowerCase())).join(" and ");
}

function credentialOf(entry: ProviderEntry): string {
  if (!entry.needsCredential) return "None";
  if (usesClientCredentials(entry.code)) return "Client ID and client secret";
  if (Object.hasOwn(OAUTH_PROVIDERS, entry.code)) return "Sign-in";
  return "Token or key";
}

/** Connectors whose code ships and which the hosted service does not offer, each with the sentence that says so. */
const NOT_OFFERED: Readonly<Record<string, { file: string; text: string }>> = {
  onedrive_sharepoint: {
    file: "docs/release-checklist.md",
    text: "Microsoft is not offered, by the owner's decision of 2026-11-06, and its button stays disabled",
  },
};

describe("docs/integration-connectors.md", () => {
  it("states every connector of the catalog, in catalog order, with its plan, credential and status", () => {
    expect(PROVIDERS).toHaveLength(19);
    const expected = providersIn().map((entry) => [
      names.providers[entry.code] ?? "",
      `\`${entry.code}\``,
      entry.category,
      whatItDoes(entry),
      planOf(entry),
      credentialOf(entry),
      Object.hasOwn(NOT_OFFERED, entry.code) ? "Not offered" : "Shipped",
    ]);
    expect(tableUnder(doc, "## Connectors")).toEqual(expected);
  });

  it("reads the plans from plans.yaml: accounting from Core and payroll from Team", () => {
    expect(plansWithFeatures().map((p) => p.code)).toEqual([
      "access",
      "core",
      "pro",
      "team",
      "enterprise",
    ]);
    const plans = new Map(tableUnder(doc, "## Connectors").map((row) => [row[1], row[4]]));
    expect(plans.get("`xero`")).toBe("Core and above");
    expect(plans.get("`gusto`")).toBe("Team and above");
    expect(plans.get("`slack`")).toBe("Every plan");
  });

  it("withholds a connector only while the sentence that withholds it stands", () => {
    for (const [code, basis] of Object.entries(NOT_OFFERED)) {
      expect(PROVIDERS.map((p) => p.code)).toContain(code);
      expect(read(basis.file), `${basis.file} still withholds ${code}`).toContain(basis.text);
      expect(doc).toContain(basis.text);
    }
  });

  it("quotes every source sentence exactly as its file holds it", () => {
    const sources = tableUnder(doc, "## Sources");
    expect(sources.length).toBeGreaterThanOrEqual(6);
    for (const [file = "", sentence = ""] of sources) {
      const path = file.replaceAll("`", "");
      expect(read(path), `${path} holds: ${sentence}`).toContain(sentence);
    }
  });

  it("gives the automation apps the plan that includes API keys, and claims no public listing", () => {
    const apiKeys = plansWithFeatures().find((p) => p.adds.includes("api_keys"));
    expect(apiKeys?.code).toBe("pro");
    const surfaces = tableUnder(doc, "## Other integration surfaces");
    expect(surfaces).toEqual([
      ["Zapier app", "Pro and above, through an organization API key", "Not publicly listed"],
      ["Make app", "Pro and above, through an organization API key", "Not publicly listed"],
      ["Warehouse delivery to Amazon S3", "Enterprise", "Shipped"],
    ]);
  });

  it("is named in the lockstep contract as a file the marketing site reads", () => {
    expect(read("design/MARKETING_LOCKSTEP.md")).toContain("`docs/integration-connectors.md`");
  });
});
