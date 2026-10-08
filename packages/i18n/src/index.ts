import enUS from "../messages/en-US.json" with { type: "json" };
import esUS from "../messages/es-US.json" with { type: "json" };

/** en-US is the source locale; every other catalog must carry exactly its keys. */
export type Messages = typeof enUS;

export const locales = ["en-US", "es-US"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en-US";

const catalogs: Record<Locale, Messages> = { "en-US": enUS, "es-US": esUS };

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}

export function getMessages(locale: Locale): Messages {
  return catalogs[locale];
}
