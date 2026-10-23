import { resolveSettings, type ResolvedSetting } from "@xos/data/settings";
import type { XosClient } from "@xos/data";
import {
  encodePreferences,
  preferencesFromSettings,
  type DisplayPreferences,
} from "@xos/ui/preferences";
import { isTimeZone } from "@xos/data/calendar";
import { cache } from "react";
import type { LanguageSetting } from "@/i18n/negotiate";

/**
 * The registered settings the Atlas shell applies on every page (Section 4.5.6, A65-001), resolved once per
 * request for the viewer in an org: display preferences (text size, contrast, motion, density, shortcuts,
 * date format, units, week start), the start page and the org's own support contacts.
 */

export type StartPage = "home" | "my-work" | "inbox" | "projects";
const START_PAGES: readonly StartPage[] = ["home", "my-work", "inbox", "projects"];

/** The page Atlas opens for an org after sign-in (shell.start_page); Home when unset or unknown. */
export function startPageOf(settings: ReadonlyMap<string, ResolvedSetting>): StartPage {
  const value = settings.get("shell.start_page")?.value;
  return START_PAGES.includes(value as StartPage) ? (value as StartPage) : "home";
}

/** The path of an org's start page. */
export function startPath(slug: string, page: StartPage): string {
  return `/${slug}/${page}`;
}

/** The org's own support contacts for the help panel (help.support_email, help.support_hours, help.custom_link). */
export interface OrgSupport {
  readonly email: string | null;
  readonly hours: string | null;
  readonly link: string | null;
}

function text(settings: ReadonlyMap<string, ResolvedSetting>, key: string): string | null {
  const value = settings.get(key)?.value;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** The org's support contacts, or null when it set none. The link must be http or https. */
export function orgSupportOf(settings: ReadonlyMap<string, ResolvedSetting>): OrgSupport | null {
  const link = text(settings, "help.custom_link");
  const support = {
    email: text(settings, "help.support_email"),
    hours: text(settings, "help.support_hours"),
    link: link && /^https?:\/\//.test(link) ? link : null,
  };
  return support.email || support.hours || support.link ? support : null;
}

/** A setting's value by key, from a resolved map or a list of stored values. */
export type SettingLookup = (key: string) => unknown;

/** The feed composer's starting switches: the org's communication.feed_reactions_default and feed_comments_default. */
export function feedSwitchDefaults(get: SettingLookup): string[] {
  return [
    ...(get("communication.feed_reactions_default") === false ? [] : ["reactionsEnabled"]),
    ...(get("communication.feed_comments_default") === false ? [] : ["commentsEnabled"]),
  ];
}

/** A new access review starts from access_reviews.remove_unreviewed. */
export function reviewRemovesUnreviewed(get: SettingLookup): boolean {
  return get("access_reviews.remove_unreviewed") === true;
}

/** A new legal entity starts from org.fiscal_year_start_month and org.base_currency. */
export function legalEntityDefaults(get: SettingLookup): { month: string; currency: string } {
  const month = get("org.fiscal_year_start_month");
  const currency = get("org.base_currency");
  return {
    month: String(typeof month === "number" ? month : 1),
    currency: (typeof currency === "string" ? currency : "USD").toUpperCase(),
  };
}

/**
 * Whether the org's own members are prompted to rate the people it engages (gateway.ratings_enabled, ADR 0038):
 * the completed engagements waiting for their rating and the Rate the party next step. Prompts only: ratings are
 * always on, members can still rate from the engagement, and turning prompts off never hides or removes a rating
 * or changes what a rated party or a marketplace viewer sees.
 */
export function ratingPromptsOn(get: SettingLookup): boolean {
  return get("gateway.ratings_enabled") !== false;
}

/** Completed engagements the org has not rated yet, to prompt a rating; none while prompts are off. */
export function engagementsToRate<E extends { readonly orgRated: boolean }>(
  get: SettingLookup,
  completed: readonly E[],
): E[] {
  return ratingPromptsOn(get) ? completed.filter((e) => !e.orgRated) : [];
}

const VISIBILITY_RANK = { Invited: 0, Pool: 0, Network: 1, Public: 2 } as const;

/**
 * The opportunity visibilities gateway.marketplace_visibility allows (migration 1327): public allows all,
 * network up to Network (the default), private only Invited and Pool.
 */
export function allowedVisibilities<V extends keyof typeof VISIBILITY_RANK>(
  get: SettingLookup,
  visibilities: readonly V[],
): V[] {
  const setting = get("gateway.marketplace_visibility");
  const cap = setting === "public" ? 2 : setting === "private" ? 0 : 1;
  return visibilities.filter((v) => VISIBILITY_RANK[v] <= cap);
}

/**
 * The device cookie a theme or language saved on a settings page sets (me.theme, locale.language), or null
 * for any other setting or a value this device does not offer.
 */
export function devicePreference(
  key: string,
  value: string,
  themes: readonly string[],
  locales: readonly string[],
): { readonly cookie: "theme" | "locale"; readonly value: string } | null {
  if (key === "me.theme" && themes.includes(value)) return { cookie: "theme", value };
  if (key === "locale.language" && locales.includes(value)) return { cookie: "locale", value };
  return null;
}

export interface ShellSettings {
  readonly preferences: DisplayPreferences;
  /** The preferences as the cookie stores them, so the shell can tell when the cookie is stale. */
  readonly encoded: string;
  readonly startPage: StartPage;
  readonly support: OrgSupport | null;
  /** locale.language as resolved here, which locale negotiation applies (i18n/negotiate.ts). */
  readonly language: LanguageSetting | null;
  /**
   * The viewer's own time zone (locale.time_zone as it resolves for them in this org), which schedule times show
   * in when they choose "my time zone" (me.time_zone_display, Section 15). Null when it is not a known zone.
   */
  readonly viewerTimeZone: string | null;
}

/** locale.language as resolved for the viewer in the org: the value, where it came from and the org's lock. */
export function languageOf(settings: ReadonlyMap<string, ResolvedSetting>): LanguageSetting | null {
  const setting = settings.get("locale.language");
  return setting ? { value: setting.value, source: setting.source, locked: setting.locked } : null;
}

export function shellSettingsOf(settings: ReadonlyMap<string, ResolvedSetting>): ShellSettings {
  const preferences = preferencesFromSettings((key) => settings.get(key)?.value);
  return {
    preferences,
    encoded: encodePreferences(preferences),
    startPage: startPageOf(settings),
    support: orgSupportOf(settings),
    language: languageOf(settings),
    viewerTimeZone: viewerTimeZoneOf(settings),
  };
}

/** locale.time_zone as resolved for the viewer, when it names a zone Intl knows. */
export function viewerTimeZoneOf(settings: ReadonlyMap<string, ResolvedSetting>): string | null {
  const zone = settings.get("locale.time_zone")?.value;
  return typeof zone === "string" && isTimeZone(zone) ? zone : null;
}

/** The viewer's resolved shell settings in an org (and workspace), once per request. */
export const getShellSettings = cache(
  async (db: XosClient, orgId: string, workspaceId: string | null): Promise<ShellSettings> => {
    const settings = await resolveSettings(db, {
      orgId,
      ...(workspaceId ? { workspaceId } : {}),
    });
    if (!settings.ok) {
      throw new Error(`Cannot resolve settings: ${JSON.stringify(settings.error)}`);
    }
    return shellSettingsOf(settings.data);
  },
);
