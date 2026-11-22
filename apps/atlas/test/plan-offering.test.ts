import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SEAT_OFFER_KEYS, seatCopyKey } from "@xos/i18n/offering";
import { PLAN_OFFERING, addonOnSale, extraSeatsOnSale } from "@xos/schemas/plans/offering";
import { describe, expect, it } from "vitest";
import { errorMessage } from "@/components/auth/error-message";
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

describe("seat copy Atlas shows", () => {
  /**
   * The database refuses a seat on a plan that prices extra seats as seat_limit_reached, whatever is on sale. Atlas
   * turns the rule into a catalog key through seatCopyKey, which reads offering.extra_seats, so the copy offers extra
   * seats only while plans.yaml states them on sale. packages/i18n/test/seat-copy.test.ts holds the catalogs and the
   * database messages to the same status.
   */
  const naming = (pattern: RegExp) =>
    sources.filter(({ text }) => pattern.test(text)).map((s) => s.path);

  it("chooses the copy of a seat refusal by the status, wherever a refusal becomes a catalog key", () => {
    // auth/actions.ts passes the rule on as `invite.<rule>`, and errorMessage chooses its copy.
    const handedOn = ["app/auth/actions.ts"];
    const named = naming(/\bseat_limit_reached\b/);
    expect(named).toEqual(expect.arrayContaining(handedOn));
    for (const path of named.filter((p) => !handedOn.includes(p))) {
      const text = sources.find((s) => s.path === path)?.text ?? "";
      expect(text, `${path} names the seat refusal, so it chooses its copy`).toContain(
        "seatCopyKey(",
      );
    }
    // The two forms that show any refusal of the platform and orgLifecycle catalogs by its rule.
    for (const path of [
      "components/platform/kit.tsx",
      "components/lifecycle/forms.tsx",
      "components/auth/error-message.ts",
    ]) {
      const text = sources.find((s) => s.path === path)?.text ?? "";
      expect(text, path).toMatch(/refus\w+\.\$\{seatCopyKey\(/);
    }
  });

  it("shows the invitation's seat refusal as the status states it", () => {
    const asked: string[] = [];
    const t = (key: string) => {
      asked.push(key);
      return key;
    };
    errorMessage(t, "invite.seat_limit_reached");
    errorMessage(t, "invite.seat_limit_upgrade");
    errorMessage(t, "invite.invite_invalid");
    expect(asked).toEqual([
      `invite.refused.${extraSeatsOnSale() ? "seat_limit_reached" : "seat_limit_reached_not_on_sale"}`,
      "invite.refused.seat_limit_upgrade",
      "invite.refused.invite_invalid",
    ]);
  });

  it("reads every other key that offers extra seats through the status", () => {
    const offerKeys = Object.keys(SEAT_OFFER_KEYS).filter((key) => key !== "seat_limit_reached");
    const literal = new RegExp(`["'\`.](${offerKeys.join("|")})["'\`]`);
    const using = sources.filter(({ text }) => literal.test(text));
    expect(using.map((s) => s.path).sort()).toEqual([
      "app/[org]/settings/billing-and-plan/page.tsx",
      "components/settings/contributions/a107.tsx",
    ]);
    for (const { path, text } of using) {
      expect(
        /seatCopyKey\(|extraSeatsOnSale\(\)/.test(text),
        `${path} shows copy that offers extra seats, so it reads whether they are on sale`,
      ).toBe(true);
    }
    const panel = using.find((s) => s.path.endsWith("a107.tsx"))?.text ?? "";
    expect(panel).toContain('t(seatCopyKey("panel.noRoom"))');
    expect(panel).not.toContain('t("panel.noRoom")');
    expect(seatCopyKey("panel.noRoom")).toBe(
      extraSeatsOnSale() ? "panel.noRoom" : "panel.noRoomNotOnSale",
    );
  });
});
