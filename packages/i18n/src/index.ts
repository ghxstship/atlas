import { enUS, esUS } from "./catalogs.generated.ts";
import { withFallback, type PartialMessages } from "./fallback.ts";
import {
  defaultLocale,
  isBetaLocale,
  type BetaLocale,
  type LaunchLocale,
  type Locale,
} from "./locales.ts";

export {
  betaLocales,
  defaultLocale,
  isBetaLocale,
  isLaunchLocale,
  isLocale,
  launchLocales,
  locales,
  type BetaLocale,
  type LaunchLocale,
  type Locale,
} from "./locales.ts";
export { coverage, withFallback, type DeepPartial, type PartialMessages } from "./fallback.ts";

/** en-US is the source locale; every launch catalog must carry exactly its keys. */
export type Messages = typeof enUS;
export type Namespace = keyof Messages;

const launch: Record<LaunchLocale, Messages> = { "en-US": enUS, "es-US": esUS };

/** Beta catalogs registered so far, already merged over en-US key by key (ADR 0053). */
const beta = new Map<BetaLocale, Messages>();

/**
 * Every namespace of one locale. Server code only: a client component that imports this pulls the
 * whole catalog into the browser. Client components get their copy from the next-intl provider
 * (see `pickNamespaces`) or import one namespace file from `@xos/i18n/messages/<locale>/<ns>.json`.
 *
 * A Beta locale reads its translations where the pipeline has written them and en-US for every other
 * key. Its catalog loads on demand: call `loadMessages` from `@xos/i18n/load` first (the shells' request
 * configuration does), or a Beta locale reads plain en-US. Either way no key is ever missing.
 */
export function getMessages(locale: Locale): Messages {
  if (isBetaLocale(locale)) return beta.get(locale) ?? launch[defaultLocale];
  return launch[locale];
}

/** Whether a Beta locale's catalog has been registered in this process. */
export function isBetaCatalogLoaded(locale: BetaLocale): boolean {
  return beta.has(locale);
}

/** Registers a Beta locale's partial catalog, merged over en-US key by key. */
export function registerBetaCatalog(locale: BetaLocale, partial: PartialMessages): Messages {
  const merged = withFallback(enUS, partial);
  beta.set(locale, merged);
  return merged;
}

/** The given namespaces of a catalog, for the client provider of a surface that uses only those. */
export function pickNamespaces<M extends Record<string, unknown>, K extends keyof M>(
  messages: M,
  namespaces: readonly K[],
): Pick<M, K> {
  const out = {} as Pick<M, K>;
  for (const ns of namespaces) {
    if (ns in messages) out[ns] = messages[ns];
  }
  return out;
}
