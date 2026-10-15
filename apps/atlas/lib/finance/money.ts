import { listCurrencies } from "@xos/data/finance";
import { cache } from "react";
import type { OrgContext } from "@/lib/shell/context";

/**
 * Money display for Finance and Reports (Section 3.7). Amounts are integer minor units; the minor
 * unit exponent comes from private.currencies (the one money reference), and a null amount always
 * renders the catalog's Unpriced label, never 0 or an empty cell.
 */

export type Exponents = ReadonlyMap<string, number>;

export const getExponents = cache(async (ctx: OrgContext): Promise<Exponents> => {
  const result = await listCurrencies(ctx.viewer.db);
  if (!result.ok) throw new Error(`Cannot list currencies: ${JSON.stringify(result.error)}`);
  return new Map(result.data.map((c) => [c.code, c.exponent]));
});

export function exponentOf(exponents: Exponents, currency: string): number {
  return exponents.get(currency) ?? 2;
}

export interface MoneyFormatter {
  /** Formats minor units in a currency, or the Unpriced label for null. */
  (amountMinor: number | null, currency: string): string;
}

export function moneyFormatter(
  locale: string,
  exponents: Exponents,
  unpricedLabel: string,
): MoneyFormatter {
  return (amountMinor, currency) => {
    if (amountMinor === null) return unpricedLabel;
    const exponent = exponentOf(exponents, currency);
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currency || "USD",
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(amountMinor / 10 ** exponent);
  };
}

/** Minor units as a plain major-unit string for editing inputs (no grouping, no symbol). */
export function toInputValue(amountMinor: number | null, exponent: number): string {
  return amountMinor === null ? "" : (amountMinor / 10 ** exponent).toFixed(exponent);
}
