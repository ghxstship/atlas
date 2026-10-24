/**
 * Loads a locale's messages on demand (ADR 0053). Launch catalogs are always present; a Beta catalog is
 * imported the first time its locale is asked for, merged over en-US key by key, and kept for the life
 * of the process. Server code that may serve a Beta locale awaits this before reading `getMessages`.
 * The Edge Function bundle never imports this module, so it carries no Beta catalog.
 */
import { betaCatalogs } from "./beta.generated.ts";
import { getMessages, isBetaCatalogLoaded, registerBetaCatalog, type Messages } from "./index.ts";
import { isBetaLocale, type Locale } from "./locales.ts";

const pending = new Map<string, Promise<Messages>>();

export async function loadMessages(locale: Locale): Promise<Messages> {
  if (!isBetaLocale(locale) || isBetaCatalogLoaded(locale)) return getMessages(locale);
  let loading = pending.get(locale);
  if (loading === undefined) {
    loading = betaCatalogs[locale]().then((partial) => registerBetaCatalog(locale, partial));
    pending.set(locale, loading);
  }
  return loading;
}
