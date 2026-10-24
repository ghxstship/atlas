import { readFileSync } from "node:fs";
import { getMessages } from "@xos/i18n";
import { EXTERNAL_AUDIENCES, INTERNAL_AUDIENCES, type Audience } from "@xos/sync";
import { describe, expect, it } from "vitest";
import {
  gatewaySectionUrl,
  groupSections,
  leadKey,
  NATIVE_SECTIONS,
  SECTION_ICONS,
  settingsSections,
} from "../src/settings/sections";

/**
 * Compass Settings lists the person's own sections (A110, ADR 0006 item 11, ADR 0070): the sitemap's 14, Keyboard
 * Shortcuts left out, the identity group native and the rest opening the same section in Gateway.
 */

const audiences: readonly Audience[] = [...INTERNAL_AUDIENCES, ...EXTERNAL_AUDIENCES];
const urls = { gatewayUrl: "https://gateway.example.test/" };
const ORDER = [
  "settings.profile",
  "settings.profile-privacy",
  "settings.account",
  "settings.security",
  "settings.organizations",
  "settings.preferences",
  "settings.accessibility",
  "settings.notifications",
  "settings.out-of-office",
  "settings.work-details",
  "settings.payout-and-tax",
  "settings.calendar-feeds",
  "settings.connected-apps",
  "settings.developer",
];

function lookup(locale: "en-US" | "es-US", key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      getMessages(locale),
    );
}

describe("Compass settings sections (A110)", () => {
  it.each(audiences)("gives %s the 14 sections in the sitemap's order", (audience) => {
    const sections = settingsSections(audience, urls, { personalTokens: true });
    expect(sections.map((s) => s.id)).toEqual(ORDER);
    expect(sections.map((s) => s.id)).not.toContain("settings.keyboard-shortcuts");
  });

  it("lists Developer only where an org the person belongs to allows personal tokens", () => {
    const without = settingsSections("field", urls, { personalTokens: false }).map((s) => s.id);
    expect(without).toHaveLength(13);
    expect(without).not.toContain("settings.developer");
    expect(settingsSections("crew", urls, { personalTokens: false })).toHaveLength(13);
  });

  it("opens the identity group and A112's work sections natively, and the rest in Gateway", () => {
    const sections = settingsSections("field", urls, { personalTokens: true });
    const native = sections.filter((s) => s.target.kind === "native").map((s) => s.id);
    expect(native).toEqual([
      "settings.profile",
      "settings.profile-privacy",
      "settings.account",
      "settings.security",
      "settings.organizations",
      "settings.payout-and-tax",
      "settings.calendar-feeds",
      "settings.connected-apps",
      "settings.developer",
    ]);
    expect(new Set(native)).toEqual(NATIVE_SECTIONS);
    expect(sections.find((s) => s.id === "settings.profile")?.target).toEqual({
      kind: "native",
      route: "/settings/profile",
    });
    expect(sections.find((s) => s.id === "settings.notifications")?.target).toEqual({
      kind: "gateway",
      url: "https://gateway.example.test/settings/notifications",
    });
    expect(sections.find((s) => s.id === "settings.developer")?.target).toEqual({
      kind: "native",
      route: "/settings/developer",
    });
  });

  it("has a Compass screen for every native section", () => {
    for (const id of NATIVE_SECTIONS) {
      const file = new URL(`../app/settings/${id.replace("settings.", "")}.tsx`, import.meta.url);
      expect(readFileSync(file, "utf8"), id).toContain("export default function");
    }
  });

  it("groups the sections as You, Preferences and Work, in that order", () => {
    const groups = groupSections(settingsSections("vendor", urls, { personalTokens: false }));
    expect(groups.map((g) => g.group)).toEqual(["identity", "preferences", "work"]);
    expect(groups[0]?.sections.map((s) => s.id)).toEqual(ORDER.slice(0, 5));
    expect(groups[1]?.sections.map((s) => s.id)).toEqual(ORDER.slice(5, 9));
    expect(groups[2]?.sections.map((s) => s.id)).toEqual(ORDER.slice(9, 13));
    expect(groupSections([])).toEqual([]);
  });

  it("names each section and its lead in English and Spanish", () => {
    for (const section of settingsSections("field", urls, { personalTokens: true })) {
      for (const locale of ["en-US", "es-US"] as const) {
        expect(typeof lookup(locale, section.label), `${locale} ${section.label}`).toBe("string");
        expect(typeof lookup(locale, section.lead), `${locale} ${section.lead}`).toBe("string");
      }
      for (const group of ["identity", "preferences", "work"]) {
        expect(typeof lookup("es-US", `compassSettings.groups.${group}`)).toBe("string");
      }
    }
  });

  it("reads Gateway's lead for a section, except Organizations, which says more in Compass", () => {
    expect(leadKey("settings.out-of-office")).toBe("gateway.settings.leads.outOfOffice");
    expect(leadKey("settings.profile-privacy")).toBe("gateway.settings.leads.profilePrivacy");
    expect(leadKey("settings.organizations")).toBe("compassSettings.leads.organizations");
  });

  it("draws every section with an icon from the registry", () => {
    const registry = readFileSync(new URL("../src/ui/icons.ts", import.meta.url), "utf8");
    for (const icon of Object.values(SECTION_ICONS)) {
      expect(registry, icon).toMatch(new RegExp(`^\\s*"?${icon}"?: `, "m"));
    }
  });

  it("joins a Gateway origin and a route with one slash", () => {
    expect(gatewaySectionUrl("https://g.example.test", "/settings/account")).toBe(
      "https://g.example.test/settings/account",
    );
    expect(gatewaySectionUrl("https://g.example.test//", "/u/ana")).toBe(
      "https://g.example.test/u/ana",
    );
  });
});
