/**
 * The person's own settings in Compass (Section 4.5.6 personal settings, ADR 0006 item 11, ADR 0070): the
 * sitemap's 14 sections of Settings (Keyboard Shortcuts is desktop only), in the sitemap's order, each opening
 * its Compass screen or, until Compass draws that section, the same section in Gateway. Gateway serves every
 * personal section at the route Compass uses, so the link is the Gateway origin plus the route.
 *
 * A110 draws the identity group natively. A111 and A112 add their sections by adding the ids to NATIVE_SECTIONS
 * and their screens under app/settings/; nothing else changes.
 */
import type { Audience } from "@xos/sync";
import { moreMenu, type MenuEntry } from "../domain/access";

/** Sections Compass draws itself. Every other section opens Gateway. */
export const NATIVE_SECTIONS: ReadonlySet<string> = new Set([
  "settings.profile",
  "settings.profile-privacy",
  "settings.account",
  "settings.security",
  "settings.organizations",
  // A111 (ADR 0071).
  "settings.preferences",
  "settings.accessibility",
  "settings.notifications",
  "settings.out-of-office",
  "settings.work-details",
]);

/** How the list groups the sections: who you are, how Compass behaves for you, and your work. */
export type SectionGroup = "identity" | "preferences" | "work";

export const SECTION_GROUPS: readonly SectionGroup[] = ["identity", "preferences", "work"];

const GROUP: Readonly<Record<string, SectionGroup>> = {
  "settings.profile": "identity",
  "settings.profile-privacy": "identity",
  "settings.account": "identity",
  "settings.security": "identity",
  "settings.organizations": "identity",
  "settings.preferences": "preferences",
  "settings.accessibility": "preferences",
  "settings.notifications": "preferences",
  "settings.out-of-office": "preferences",
  "settings.work-details": "work",
  "settings.payout-and-tax": "work",
  "settings.calendar-feeds": "work",
  "settings.connected-apps": "work",
  "settings.developer": "work",
};

/** Icons by section id, from the icon registry (src/ui/icons.ts). */
export const SECTION_ICONS: Readonly<Record<string, string>> = {
  "settings.profile": "user",
  "settings.profile-privacy": "eye-off",
  "settings.account": "key-round",
  "settings.security": "shield-check",
  "settings.organizations": "building-2",
  "settings.preferences": "sliders-horizontal",
  "settings.accessibility": "accessibility",
  "settings.notifications": "bell",
  "settings.out-of-office": "plane",
  "settings.work-details": "briefcase",
  "settings.payout-and-tax": "banknote",
  "settings.calendar-feeds": "calendar-sync",
  "settings.connected-apps": "plug",
  "settings.developer": "code",
};

export type SectionTarget =
  | { readonly kind: "native"; readonly route: string }
  | { readonly kind: "gateway"; readonly url: string };

export interface SettingsSection {
  readonly id: string;
  /** Message key of the section's name (nav.settings.personal.*). */
  readonly label: string;
  /** Message key of the one-line description Gateway shows under the section's heading. */
  readonly lead: string;
  readonly icon: string;
  readonly group: SectionGroup;
  readonly target: SectionTarget;
}

/** What the device knows about the sitemap conditions of the sections. */
export interface SectionConditions {
  /** An org the person belongs to allows personal API tokens (developer.personal_tokens, migration 1432). */
  readonly personalTokens: boolean;
}

/** The Gateway page of a section: Gateway serves each personal section at the route Compass uses. */
export function gatewaySectionUrl(gatewayUrl: string, route: string): string {
  return `${gatewayUrl.replace(/\/+$/, "")}${route}`;
}

/** Leads that differ in Compass: its Organizations lists memberships and engagements as well as company accounts. */
const COMPASS_LEADS: Readonly<Record<string, string>> = {
  "settings.organizations": "compassSettings.leads.organizations",
};

/** Gateway's lead key for a section id: settings.out-of-office reads gateway.settings.leads.outOfOffice. */
export function leadKey(id: string): string {
  const own = COMPASS_LEADS[id];
  if (own) return own;
  const name = id
    .replace(/^settings\./, "")
    .replace(/[.-]([a-z])/g, (_, c: string) => c.toUpperCase());
  return `gateway.settings.leads.${name}`;
}

function conditionsMet(entry: MenuEntry, conditions: SectionConditions): boolean {
  return entry.conditions.every((c) =>
    c === "org-allows-personal-tokens" ? conditions.personalTokens : false,
  );
}

/** The audience's settings sections, in the sitemap's order, each with where it opens. */
export function settingsSections(
  audience: Audience,
  urls: { readonly gatewayUrl: string },
  conditions: SectionConditions,
): SettingsSection[] {
  const settings = moreMenu(audience).find((m) => m.id === "settings");
  return (settings?.children ?? [])
    .filter((entry) => conditionsMet(entry, conditions))
    .map((entry) => ({
      id: entry.id,
      label: entry.label,
      lead: leadKey(entry.id),
      icon: SECTION_ICONS[entry.id] ?? "chevron-right",
      group: GROUP[entry.id] ?? "work",
      target: NATIVE_SECTIONS.has(entry.id)
        ? { kind: "native", route: entry.route }
        : { kind: "gateway", url: gatewaySectionUrl(urls.gatewayUrl, entry.route) },
    }));
}

/** The sections by group, in group order, leaving out a group with no section. */
export function groupSections(
  sections: readonly SettingsSection[],
): { readonly group: SectionGroup; readonly sections: readonly SettingsSection[] }[] {
  return SECTION_GROUPS.map((group) => ({
    group,
    sections: sections.filter((s) => s.group === group),
  })).filter((g) => g.sections.length > 0);
}
