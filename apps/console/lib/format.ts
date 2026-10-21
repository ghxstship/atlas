import { getTranslations } from "next-intl/server";
import { negotiatedLocale } from "@/i18n/request";

/** Translator over the `console` namespace with keys built at runtime (enum values, refusal rules). */
export type ConsoleT = (key: string, values?: Record<string, string | number>) => string;

export interface ConsoleFormat {
  readonly t: ConsoleT;
  /** Whether the catalog holds a key. */
  readonly has: (key: string) => boolean;
  /** A catalog label for an enum value, or the value itself when the catalog has none. */
  readonly label: (group: string, value: string) => string;
  readonly locale: string;
  /**
   * An instant for the platform team, who work across time zones: date and time in UTC, named as UTC. The console
   * shows only instants, never a tenant's business dates (ADR 0046).
   */
  readonly instant: (iso: string | null) => string;
  readonly number: (n: number) => string;
}

export async function getConsoleFormat(): Promise<ConsoleFormat> {
  const [raw, locale] = await Promise.all([getTranslations("console"), negotiatedLocale()]);
  const t: ConsoleT = (key, values) => (raw as unknown as ConsoleT)(key, values);
  const has = (key: string) => (raw as unknown as { has: (k: string) => boolean }).has(key);
  const instantFormat = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });
  const numberFormat = new Intl.NumberFormat(locale);
  return {
    t,
    has,
    label: (group, value) => (has(`${group}.${value}`) ? t(`${group}.${value}`) : value),
    locale,
    instant: (iso) => (iso ? `${instantFormat.format(new Date(iso))} UTC` : t("common.never")),
    number: (n) => numberFormat.format(n),
  };
}
