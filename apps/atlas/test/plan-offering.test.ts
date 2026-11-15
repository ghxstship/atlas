import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PLAN_OFFERING, addonOnSale, extraSeatsOnSale } from "@xos/schemas/plans/offering";
import { describe, expect, it } from "vitest";
import { ADDONS, PLANS } from "@/lib/plans.generated";
import { PLAN_REGISTRY } from "@/lib/billing/plan-registry.generated";

/**
 * Atlas shows what plans.yaml states is offered and on sale, and keeps no list of its own (ADR 0035, 2026-11-15
 * amendment; ghxstship/atlas issues 108 and 116). The marketing site reads the same section, so the two cannot disagree.
 * billing-checkout.test.ts renders Billing and Plan and checks what it lists; this file holds the rules that keep
 * any other surface, and any later change, to the same statuses.
 */
const appRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

/** Every hand-written source file of Atlas that a customer's page or email can come from. */
const sources = ["app", "components", "lib", "emails"]
  .flatMap((dir) => {
    try {
      return walk(join(appRoot, dir));
    } catch {
      return [];
    }
  })
  .filter((path) => /\.tsx?$/.test(path) && !/\.generated\.tsx?$/.test(path))
  .map((path) => ({ path: relative(appRoot, path), text: readFileSync(path, "utf8") }));

const withheldFeatures = Object.entries(PLAN_OFFERING.features)
  .filter(([, f]) => f.status !== "offered")
  .map(([code]) => code);

describe("plan features Atlas lists", () => {
  it("carries the offering of plans.yaml into the generated registry unchanged", () => {
    expect(PLAN_REGISTRY.offering).toEqual(PLAN_OFFERING);
    expect(Object.keys(PLAN_OFFERING.features)).toEqual([...PLAN_REGISTRY.features]);
    expect(PLANS.flatMap((p) => p.adds).sort()).toEqual([...PLAN_REGISTRY.features].sort());
  });

  it("filters every list of plan features through the offering", () => {
    // A surface lists plan features by their labels, shell.plans.features.<code>, or the same map in another catalog.
    const listing = sources.filter(({ text }) => /plans\.features\b/.test(text));
    expect(listing.map((s) => s.path)).toEqual(["app/[org]/settings/billing-and-plan/page.tsx"]);
    for (const { path, text } of listing) {
      expect(
        /planFeatureOffered\(|isPlanFeatureOffered\(|offeredPlanFeatures\(/.test(text),
        `${path} lists plan features, so it reads their offered status`,
      ).toBe(true);
    }
  });

  it("names no withheld feature in a page or an email by hand", () => {
    expect(withheldFeatures).toEqual([
      "eu_data_residency",
      "branded_compass_build",
      "legend_early_access",
    ]);
    const catalog = JSON.parse(
      readFileSync(join(repoRoot, "packages/i18n/messages/en-US/shell.json"), "utf8"),
    ) as { plans: { features: Record<string, string> } };
    for (const code of withheldFeatures) {
      const label = catalog.plans.features[code];
      expect(label, code).toBeTypeOf("string");
      const naming = sources.filter(
        ({ text }) => text.includes(`"${code}"`) || text.includes(`'${code}'`),
      );
      expect(
        naming.map((s) => s.path),
        code,
      ).toEqual([]);
      // The label lives under shell.plans.features only, where the filtered list reads it.
      const elsewhere = Object.entries(flatten(catalog)).filter(
        ([key, value]) => value === label && key !== `plans.features.${code}`,
      );
      expect(elsewhere, code).toEqual([]);
    }
  });
});

function flatten(value: unknown, prefix = ""): Record<string, string> {
  if (typeof value === "string") return { [prefix]: value };
  if (value === null || typeof value !== "object") return {};
  return Object.assign(
    {},
    ...Object.entries(value).map(([key, child]) =>
      flatten(child, prefix === "" ? key : `${prefix}.${key}`),
    ),
  ) as Record<string, string>;
}

describe("purchases Atlas offers", () => {
  /** The platform calls that sell extra seats and add-ons (ADR 0035, section 4 and the Consequences). */
  const seatPurchase = /\bsetExtraSeats\b|\bextraSeats:\s/;
  const addonPurchase = /\bcreateAddonCheckoutSession\b|\bstartAddonCheckout\b/;
  const wired = (pattern: RegExp) =>
    sources.filter(({ text }) => pattern.test(text)).map((s) => s.path);

  it("states extra seats on sale only once Atlas has a purchase for them", () => {
    if (wired(seatPurchase).length === 0) expect(extraSeatsOnSale()).toBe(false);
  });

  it("states an add-on on sale only once Atlas has a purchase for it", () => {
    if (wired(addonPurchase).length === 0) {
      expect(ADDONS.filter((a) => addonOnSale(a.code)).map((a) => a.code)).toEqual([]);
    }
  });

  it("reads both statuses on Billing and Plan, the one page that prices them", () => {
    const pricing = sources.filter(({ text }) =>
      /usdExtraSeatMonthlyMinor|auroraPack|\bADDONS\b|buySeats/.test(text),
    );
    expect(pricing.map((s) => s.path)).toEqual(["app/[org]/settings/billing-and-plan/page.tsx"]);
    const page = pricing[0]?.text ?? "";
    expect(page).toContain("extraSeatsOnSale()");
    expect(page).toContain("addonOnSale(a.code)");
  });

  it("matches ADR 0035, which records that neither can be bought on Billing and Plan", () => {
    const adr = readFileSync(
      join(repoRoot, "docs/adr/0035-pricing-v4-seats-and-add-ons.md"),
      "utf8",
    );
    if (adr.includes("extra seats, Aurora packs and Talk to sales stay as they were")) {
      expect(extraSeatsOnSale()).toBe(false);
      expect(addonOnSale("aurora_requests_1000")).toBe(false);
    }
  });
});
