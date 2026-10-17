import { getLocale, getTranslations } from "next-intl/server";
import { getExponents, moneyFormatter, type MoneyFormatter } from "@/lib/finance/money";
import type { OrgContext } from "@/lib/shell/context";

/** Translator over the `platform` namespace with keys built at runtime. */
export type PlatformT = (key: string, values?: Record<string, string | number>) => string;

export async function getPlatformT(): Promise<PlatformT> {
  const t = await getTranslations("platform");
  return (key, values) => (t as unknown as PlatformT)(key, values);
}

export interface Formatters {
  readonly t: PlatformT;
  readonly locale: string;
  readonly money: MoneyFormatter;
  readonly date: (iso: string) => string;
  readonly dateTime: (iso: string) => string;
  readonly month: (isoDate: string) => string;
  readonly number: (n: number) => string;
}

/** Money (null renders Unpriced), dates and numbers in the viewer's language. */
export async function getFormatters(ctx: OrgContext): Promise<Formatters> {
  const [t, locale, exponents] = await Promise.all([
    getPlatformT(),
    getLocale(),
    getExponents(ctx),
  ]);
  return {
    t,
    locale,
    money: moneyFormatter(locale, exponents, t("common.unpriced")),
    date: (iso) =>
      new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
        new Date(iso),
      ),
    dateTime: (iso) =>
      new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(iso),
      ),
    month: (isoDate) =>
      new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(
        new Date(`${isoDate}T00:00:00Z`),
      ),
    number: (n) => new Intl.NumberFormat(locale).format(n),
  };
}
