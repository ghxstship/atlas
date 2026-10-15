/**
 * Money for the assets pages (Section 3.11): amounts are stored in integer minor units and an
 * unknown amount stays null, never zero. The minor unit exponent of a currency comes from Intl, so
 * no currency table is redefined here.
 */

export function currencyExponent(currency: string): number {
  return (
    new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

/** A typed amount such as "45.5" or "1,200" in minor units, or null when it is not an amount. */
export function minorUnits(typed: string, currency: string): number | null {
  const clean = typed.replace(/[,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(clean)) return null;
  const exponent = currencyExponent(currency);
  const [whole = "0", fraction = ""] = clean.split(".");
  if (fraction.length > exponent) return null;
  const minor = Number(whole) * 10 ** exponent + Number(fraction.padEnd(exponent, "0") || "0");
  return Number.isSafeInteger(minor) ? minor : null;
}

/** Minor units as the major-unit number the Money component formats; null stays null. */
export function majorUnits(minor: number | null, currency: string | null): number | null {
  if (minor === null || currency === null) return null;
  return minor / 10 ** currencyExponent(currency);
}
