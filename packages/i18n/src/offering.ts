import { launchLocales, offeredLocaleList, type Locale } from "./locales.ts";

/**
 * Where XOS is offered (ADR 0160). private.territories in the database is the one source of truth, and an operator changes
 * it in the console with no code change; api_public.offered_territories is how every shell reads it. This module is
 * only the reader. Its default is the launch state, the United States alone, and a failed read gives the default, so the
 * failure mode is a closed territory rather than an open one.
 */

export interface OfferedTerritory {
  readonly code: string;
  readonly nameEn: string;
  readonly nameEs: string;
  readonly countries: readonly string[];
  readonly currencies: readonly string[];
  readonly locales: readonly string[];
}

export interface Offering {
  readonly territories: readonly OfferedTerritory[];
  /** Offered territories' countries. */
  readonly countries: readonly string[];
  /** Offered territories' price book currencies; USD always. */
  readonly currencies: readonly string[];
  /** Languages offered as choices; the launch locales always, en-US and es-US. */
  readonly locales: readonly Locale[];
}

/** The launch state, as migration 6150 seeds it; test/offering.test.ts holds the two equal. */
export const DEFAULT_OFFERING: Offering = offeringFrom([
  {
    code: "US",
    nameEn: "the United States",
    nameEs: "los Estados Unidos",
    countries: ["US", "PR", "VI", "GU", "AS", "MP"],
    currencies: ["USD"],
    locales: launchLocales,
  },
]);

/** How long a shell keeps the offering, so an operator's change reaches every server within a minute. */
export const OFFERING_CACHE_SECONDS = 60;

export function offeringFrom(territories: readonly OfferedTerritory[]): Offering {
  return {
    territories,
    countries: [...new Set(territories.flatMap((t) => t.countries))],
    currencies: [...new Set(["USD", ...territories.flatMap((t) => t.currencies)])],
    locales: offeredLocaleList(territories.flatMap((t) => t.locales)),
  };
}

/** The one call this module makes, so it needs no Supabase dependency: any client with that schema exposed fits. */
export interface OfferingClient {
  schema(name: "api_public"): {
    rpc(fn: "offered_territories"): PromiseLike<{ data: unknown; error: unknown }>;
  };
}

const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** The offering as the database has it now, or the launch state when it cannot be read. Never throws. */
export async function readOffering(db: OfferingClient): Promise<Offering> {
  try {
    const { data, error } = await db.schema("api_public").rpc("offered_territories");
    if (error || !Array.isArray(data) || data.length === 0) return DEFAULT_OFFERING;
    return offeringFrom(
      (data as Record<string, unknown>[]).map((row) => ({
        code: String(row["code"]),
        nameEn: String(row["name_en"]),
        nameEs: String(row["name_es"]),
        countries: list(row["country_codes"]),
        currencies: list(row["currency_codes"]),
        locales: list(row["locale_codes"]),
      })),
    );
  } catch {
    return DEFAULT_OFFERING;
  }
}

/**
 * A reader that keeps the offering for `ttlSeconds` and answers from the last good read while another is under way. A read
 * that failed is not kept, so the next request asks again. `ttlSeconds` of 0 reads every time, as development does, so
 * a journey that opens a territory sees it at once.
 */
export function createOfferingCache(
  read: () => Promise<Offering>,
  ttlSeconds: number = OFFERING_CACHE_SECONDS,
  clock: () => number = Date.now,
): () => Promise<Offering> {
  let entry: { readonly at: number; readonly offering: Offering } | null = null;
  let pending: Promise<Offering> | null = null;
  return async function cached(): Promise<Offering> {
    if (entry && clock() - entry.at < ttlSeconds * 1000) return entry.offering;
    if (pending) return pending;
    pending = read()
      .then((offering) => {
        if (offering !== DEFAULT_OFFERING) entry = { at: clock(), offering };
        return offering;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}

/**
 * What each shell calls: the offering through its own short-lived cache, read by a signed-out client so the answer does
 * not depend on who is asking. A client that cannot be made (no environment at build time) reads as the launch state.
 */
export function createOfferingReader(
  connect: () => OfferingClient,
  production: boolean,
): () => Promise<Offering> {
  return createOfferingCache(
    async () => {
      try {
        return await readOffering(connect());
      } catch {
        return DEFAULT_OFFERING;
      }
    },
    production ? OFFERING_CACHE_SECONDS : 0,
  );
}

/** The offered territories' names in the reader's language, for "XOS is offered to organizations in ...". */
export function offeringNames(offering: Offering, locale: string): string[] {
  return offering.territories.map((t) => (locale.startsWith("es") ? t.nameEs : t.nameEn));
}

/**
 * A plan feature that says the plan is sold somewhere: shown only while that territory is open. Mentioning customers in a
 * place is one of the signs of offering that GDPR Recital 23 names, so "EU data residency" stays off a price list until
 * the EEA opens.
 */
const FEATURE_TERRITORY: Readonly<Record<string, string>> = { eu_data_residency: "EEA" };

export function planFeatureOffered(feature: string, offering: Offering): boolean {
  const territory = FEATURE_TERRITORY[feature];
  return territory === undefined || offering.territories.some((t) => t.code === territory);
}
