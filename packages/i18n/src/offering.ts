import { launchLocales, offeredLocaleList, type Locale } from "./locales.ts";

/**
 * Where XOS is offered (ADR 0160). private.territories in the database is the one source of truth, and an operator changes
 * it in the console with no code change; api_public.offered_territories is how every shell reads it. This module is
 * only the reader. Its default is the launch state, the United States alone, and a failed or slow read gives the default,
 * so the failure mode is a closed territory rather than an open one, and never a page left waiting.
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

/**
 * How long a shell keeps the offering. A busy server shows an operator's change within about a minute; the database's
 * signup gate is live, so only prices and languages can lag. The bound is this plus OFFERING_STALE_SECONDS, about 11
 * minutes: the first request after a long quiet spell, or while reads fail, can still be answered from the last good read.
 */
export const OFFERING_CACHE_SECONDS = 60;

/** How long a good read still answers while newer ones fail, before the launch state does. */
export const OFFERING_STALE_SECONDS = 600;

/** How long a page waits for the offering: every page in every shell does, so a stalled database must not hold them. */
export const OFFERING_READ_TIMEOUT_MS = 1500;

/** Give this to the reader's Supabase client: supabase-js sets no timeout of its own, so a stalled read would hang on. */
export const offeringFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(OFFERING_READ_TIMEOUT_MS) });

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
 * A reader that keeps the offering for `ttlSeconds`. Once that passes, the last good read answers at once while one
 * request refreshes behind it, for up to `staleSeconds`, so no page waits on a refresh. With no good read to answer from,
 * callers share the one read under way and wait at most `timeoutMs`, then get the launch state. A failed read is not kept,
 * so the next request asks again. `ttlSeconds` of 0 reads every time, as development does and as a production build
 * under test does (E2E_OFFERING_FRESH=1), so a journey that opens a territory sees it at once.
 */
export function createOfferingCache(
  read: () => Promise<Offering>,
  ttlSeconds: number = OFFERING_CACHE_SECONDS,
  clock: () => number = Date.now,
  timeoutMs: number = OFFERING_READ_TIMEOUT_MS,
  staleSeconds: number = OFFERING_STALE_SECONDS,
): () => Promise<Offering> {
  let entry: { readonly at: number; readonly offering: Offering } | null = null;
  let pending: Promise<Offering> | null = null;
  const refresh = (): Promise<Offering> => {
    if (pending) return pending;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<Offering>((resolve) => {
      timer = setTimeout(() => resolve(DEFAULT_OFFERING), timeoutMs);
    });
    const done = read().then((offering) => {
      if (ttlSeconds > 0 && offering !== DEFAULT_OFFERING) entry = { at: clock(), offering };
      return offering;
    });
    pending = Promise.race([done, late])
      .catch(() => DEFAULT_OFFERING)
      .finally(() => {
        clearTimeout(timer);
        pending = null;
      });
    return pending;
  };
  return async function cached(): Promise<Offering> {
    const age = entry ? clock() - entry.at : Number.POSITIVE_INFINITY;
    if (entry && age < ttlSeconds * 1000) return entry.offering;
    const refreshed = refresh();
    if (entry && age < (ttlSeconds + staleSeconds) * 1000) return entry.offering;
    return refreshed;
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

/** The offered territories as one phrase: "the United States". */
export function offeringPhrase(offering: Offering, locale: string): string {
  return new Intl.ListFormat(locale, { type: "conjunction" }).format(
    offeringNames(offering, locale),
  );
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
