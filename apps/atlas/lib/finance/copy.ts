import { getFormatter, getLocale } from "next-intl/server";
import type { OrgContext } from "@/lib/shell/context";
import { getTranslate, type Translate } from "@/lib/shell/translate";
import { getExponents, moneyFormatter, type Exponents, type MoneyFormatter } from "./money";
import { stateKey, type Lifecycle } from "./states";

/**
 * The formatting a finance page needs, resolved once: catalog lookups, NULL-aware money, dates and
 * state labels. Every user-facing string comes from the catalogs (Section 15).
 */
export interface FinanceCopy {
  readonly t: Translate;
  readonly money: MoneyFormatter;
  readonly exponents: Exponents;
  readonly date: (iso: string | null) => string;
  readonly dateTime: (iso: string) => string;
  readonly state: (lifecycle: Lifecycle, state: string) => string;
  readonly number: (n: number) => string;
}

export async function getFinanceCopy(ctx: OrgContext): Promise<FinanceCopy> {
  const [t, format, locale, exponents] = await Promise.all([
    getTranslate(),
    getFormatter(),
    getLocale(),
    getExponents(ctx),
  ]);
  return {
    t,
    exponents,
    money: moneyFormatter(locale, exponents, t("finance.common.unpriced")),
    date: (iso) =>
      iso === null
        ? ""
        : format.dateTime(new Date(`${iso.slice(0, 10)}T00:00:00`), { dateStyle: "medium" }),
    dateTime: (iso) => format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" }),
    state: (lifecycle, state) => t(stateKey(lifecycle, state)),
    number: (n) => format.number(n),
  };
}
