import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getMessages } from "@xos/i18n";
import { EXTERNAL_AUDIENCES, INTERNAL_AUDIENCES, type Audience } from "@xos/sync";
import { describe, expect, it } from "vitest";
import { gatewaySectionUrl, settingsSections } from "../src/settings/sections";

/**
 * Compass Settings parity (A112, ADR 0006 item 11; ADR 0070, 0071 and 0072): each of the sitemap's 14 personal
 * sections (Keyboard Shortcuts is desktop only) with the Compass screen it opens at its sitemap route, or, while it
 * has none, the stated reason it opens Gateway instead; and each step a screen leaves to Gateway on purpose, with the
 * reason the screen shows. A section with a screen must open it, and a section without one must say why here.
 */

interface Parity {
  readonly id: string;
  /** The section's route: its Compass screen, and the same page in Gateway. */
  readonly route: string;
  /** Why the section opens Gateway while Compass has no screen for it. Drop it once the screen lands. */
  readonly untilScreen?: string;
  /** Steps the screen opens in Gateway on purpose: what the step is, and the message key of the reason it shows. */
  readonly inGateway?: readonly { readonly step: string; readonly reason: string }[];
}

/** A111 (RRR-156) draws the preferences group and Work Details; Gateway serves them until its screens land. */
const A111 =
  "A111 (RRR-156) draws this section; until its screen lands, the same section opens in Gateway.";

const PARITY: readonly Parity[] = [
  { id: "settings.profile", route: "/settings/profile" },
  { id: "settings.profile-privacy", route: "/settings/profile-privacy" },
  { id: "settings.account", route: "/settings/account" },
  {
    id: "settings.security",
    route: "/settings/security",
    inGateway: [
      // A security key or passkey belongs to a web address; Compass cannot use one.
      {
        step: "add a security key or passkey",
        reason: "compassSettings.security.keysInGatewayHelp",
      },
      { step: "step up with only a security key", reason: "compassSettings.stepUp.elsewhere" },
    ],
  },
  {
    id: "settings.organizations",
    route: "/settings/organizations",
    inGateway: [
      {
        step: "create a company account",
        reason: "compassSettings.organizations.createInGateway",
      },
    ],
  },
  { id: "settings.preferences", route: "/settings/preferences", untilScreen: A111 },
  { id: "settings.accessibility", route: "/settings/accessibility", untilScreen: A111 },
  { id: "settings.notifications", route: "/settings/notifications", untilScreen: A111 },
  { id: "settings.out-of-office", route: "/settings/out-of-office", untilScreen: A111 },
  { id: "settings.work-details", route: "/settings/work-details", untilScreen: A111 },
  {
    id: "settings.payout-and-tax",
    route: "/settings/payout-and-tax",
    inGateway: [
      // The form goes to the org that asks for it, from that engagement's onboarding; Compass has no engagement
      // screen. Payout details are entered at each org's payment provider, never in XOS.
      { step: "give a tax form", reason: "compassSettings.payoutTax.giveTaxFormReason" },
    ],
  },
  { id: "settings.calendar-feeds", route: "/settings/calendar-feeds" },
  { id: "settings.connected-apps", route: "/settings/connected-apps" },
  {
    id: "settings.developer",
    route: "/settings/developer",
    inGateway: [
      // The secret is shown once and belongs on the computer that runs the script; issuing it needs step-up.
      { step: "create a personal API token", reason: "compassSettings.developer.createReason" },
    ],
  },
];

const audiences: readonly Audience[] = [...INTERNAL_AUDIENCES, ...EXTERNAL_AUDIENCES];
const urls = { gatewayUrl: "https://gateway.example.test" };
const appRoot = fileURLToPath(new URL("../", import.meta.url));
const screenFile = (route: string) => join(appRoot, "app", `${route}.tsx`);
const hasScreen = (route: string) => existsSync(screenFile(route));

/** The source of every settings screen and the pieces they draw with. */
const screens = [join(appRoot, "app/settings"), join(appRoot, "src/screens/settings")]
  .flatMap((dir) => readdirSync(dir).map((file) => readFileSync(join(dir, file), "utf8")))
  .join("\n");

function message(locale: "en-US" | "es-US", key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
      getMessages(locale),
    );
}

describe("Compass settings parity", () => {
  it("accounts for the sitemap's 14 personal sections, in its order", () => {
    expect(PARITY).toHaveLength(14);
    expect(settingsSections("field", urls, { personalTokens: true }).map((s) => s.id)).toEqual(
      PARITY.map((p) => p.id),
    );
  });

  it.each(audiences)(
    "opens each section %s sees in its Compass screen, or in Gateway with a stated reason",
    (audience) => {
      const sections = settingsSections(audience, urls, { personalTokens: true });
      expect(sections.length).toBeGreaterThan(0);
      for (const section of sections) {
        const parity = PARITY.find((p) => p.id === section.id);
        if (!parity) throw new Error(`${section.id} is missing from PARITY`);
        if (hasScreen(parity.route)) {
          expect(section.target, section.id).toEqual({ kind: "native", route: parity.route });
        } else {
          expect(parity.untilScreen, `${section.id} opens Gateway without a reason`).toBeTruthy();
          expect(section.target, section.id).toEqual({
            kind: "gateway",
            url: gatewaySectionUrl(urls.gatewayUrl, parity.route),
          });
        }
      }
    },
  );

  it("draws every section that states no reason in its own screen", () => {
    const own = PARITY.filter((p) => p.untilScreen === undefined);
    // A110's identity group and A112's four work sections, and A111's five once their screens land.
    expect(own.length).toBeGreaterThanOrEqual(9);
    for (const { route } of own) {
      expect(readFileSync(screenFile(route), "utf8"), route).toContain("export default function");
    }
  });

  it("states the reason of every step left to Gateway, in English and Spanish, on the screen", () => {
    const steps = PARITY.flatMap((p) => (p.inGateway ?? []).map((s) => ({ ...s, id: p.id })));
    expect(steps.length).toBeGreaterThan(0);
    for (const { id, step, reason } of steps) {
      for (const locale of ["en-US", "es-US"] as const) {
        expect(typeof message(locale, reason), `${id}: ${step} (${locale})`).toBe("string");
      }
      // The screen names the reason's key, in full or as its last part under a constant naming the rest.
      const prefix = reason.slice(0, reason.lastIndexOf("."));
      const last = reason.slice(reason.lastIndexOf(".") + 1);
      expect(
        screens.includes(`"${reason}"`) ||
          (screens.includes(`"${prefix}"`) && screens.includes(`.${last}\``)),
        `${id}: ${step}`,
      ).toBe(true);
    }
  });
});
