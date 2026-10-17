import { enUS, esUS } from "./catalogs.generated.ts";
import type { Locale } from "./locales.ts";

export { defaultLocale, isLocale, locales, type Locale } from "./locales.ts";

/** en-US is the source locale; every other catalog must carry exactly its keys. */
export type Messages = typeof enUS;
export type Namespace = keyof Messages;

const catalogs: Record<Locale, Messages> = { "en-US": enUS, "es-US": esUS };

/**
 * Every namespace of one locale. Server code only: a client component that imports this pulls the
 * whole catalog into the browser. Client components get their copy from the next-intl provider
 * (see `pickNamespaces`) or import one namespace file from `@xos/i18n/messages/<locale>/<ns>.json`.
 */
export function getMessages(locale: Locale): Messages {
  return catalogs[locale];
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
