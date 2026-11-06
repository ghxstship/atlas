import type { NumberFormat } from "./import-parse.ts";

/**
 * Reading a standing rate typed in a file or a form (B10, G-132). Its own module, so the import-run function loads it only
 * for a pool invitation import and its boot stays under the ceiling.
 */

const SEPARATORS: Readonly<Record<NumberFormat, { group: string; decimal: string }>> = {
  "comma-dot": { group: ",", decimal: "." },
  "dot-comma": { group: ".", decimal: "," },
  "space-comma": { group: " ", decimal: "," },
  "apostrophe-dot": { group: "'", decimal: "." },
};

/** The rate bases a standing rate takes, as the database's rate type enum writes them. */
export type RateBasis = "Hourly" | "Day" | "Flat";

export type ParsedRate =
  | {
      readonly ok: true;
      readonly minor: number;
      readonly currency: string;
      readonly basis: RateBasis | null;
    }
  | { readonly ok: false; readonly issue: "invalid_rate" | "rate_currency_required" };

const SYMBOLS: Readonly<Record<string, readonly string[]>> = {
  US$: ["USD"],
  MX$: ["MXN"],
  CA$: ["CAD"],
  A$: ["AUD"],
  "€": ["EUR"],
  "£": ["GBP"],
  // Symbols that many currencies write: a bare one only means the org's base currency when that currency uses it.
  $: ["USD", "MXN", "CAD", "AUD"],
  "¥": ["JPY", "CNY"],
};

const SUFFIXES: readonly (readonly [RegExp, RateBasis])[] = [
  [/(?:\/\s*(?:hr|hrs|hour|hora)|\bper\s+hour|\bpor\s+hora)\s*$/i, "Hourly"],
  [/(?:\/\s*(?:day|d[ií]a)|\bper\s+day|\bpor\s+d[ií]a)\s*$/i, "Day"],
  [/\b(?:flat|fijo)\s*$/i, "Flat"],
];

const MAX_MINOR = 1_000_000_000_000;

/**
 * Reads a rate cell in the import's number format: an amount with an optional currency (an ISO code or one of $, US$,
 * MX$, CA$, A$, €, £, ¥, before or after it) and an optional rate type suffix in English or Spanish. A bare $ or ¥ is
 * the org's base currency when that currency uses the symbol, else the rate says rate_currency_required. Without a
 * currency in the cell, `columnCurrency` then `baseCurrency` answer. Fraction digits never exceed the currency's
 * exponent, a negative amount is refused, and the amount stays at or under 10^12 minor units.
 */
export function parseRate(
  input: string,
  numberFormat: NumberFormat,
  exponentOf: (currency: string) => number | null | undefined,
  baseCurrency: string | null,
  columnCurrency: string | null = null,
): ParsedRate {
  // NBSP and U+202F group digits like a space, and U+2019 like an apostrophe.
  let text = input
    .replace(/[\u00a0\u202f]/g, " ")
    .replace(/\u2019/g, "'")
    .trim();
  let basis: RateBasis | null = null;
  for (const [pattern, value] of SUFFIXES) {
    if (pattern.test(text)) {
      basis = value;
      text = text.replace(pattern, "").trim();
      break;
    }
  }
  let currency: string | null = null;
  const code = /(?:^|\s)([A-Za-z]{3})$|^([A-Za-z]{3})(?:\s|(?=[\d-]))/.exec(text);
  if (code) {
    currency = (code[1] ?? code[2] ?? "").toUpperCase();
    text = text.replace(code[0], " ").trim();
  } else {
    for (const symbol of ["US$", "MX$", "CA$", "A$", "€", "£", "$", "¥"]) {
      if (text.startsWith(symbol) || text.endsWith(symbol)) {
        const known = SYMBOLS[symbol] ?? [];
        text = (
          text.startsWith(symbol) ? text.slice(symbol.length) : text.slice(0, -symbol.length)
        ).trim();
        if (known.length === 1) currency = known[0] ?? null;
        else if (baseCurrency && known.includes(baseCurrency)) currency = baseCurrency;
        else return { ok: false, issue: "rate_currency_required" };
        break;
      }
    }
  }
  currency ??= columnCurrency?.trim().toUpperCase() || baseCurrency;
  if (!currency) return { ok: false, issue: "rate_currency_required" };
  const exponent = exponentOf(currency);
  if (exponent === null || exponent === undefined) return { ok: false, issue: "invalid_rate" };
  const { group, decimal } = SEPARATORS[numberFormat];
  if (text.startsWith("-") || text === "") return { ok: false, issue: "invalid_rate" };
  const escaped = group === "." ? "\\." : group;
  const shape = new RegExp(
    `^(\\d{1,3}(?:${escaped}\\d{3})+|\\d+)(?:${decimal === "." ? "\\." : decimal}(\\d+))?$`,
  ).exec(text);
  if (!shape) return { ok: false, issue: "invalid_rate" };
  const whole = (shape[1] ?? "").split(group).join("");
  const fraction = shape[2] ?? "";
  if (fraction.length > exponent) return { ok: false, issue: "invalid_rate" };
  const minor = Number(whole) * 10 ** exponent + Number(fraction.padEnd(exponent, "0") || "0");
  if (!Number.isSafeInteger(minor) || minor > MAX_MINOR)
    return { ok: false, issue: "invalid_rate" };
  return { ok: true, minor, currency, basis };
}

const RATE_TYPE_WORDS: Readonly<Record<string, RateBasis>> = {
  hourly: "Hourly",
  hour: "Hourly",
  hr: "Hourly",
  hora: "Hourly",
  "por hora": "Hourly",
  day: "Day",
  daily: "Day",
  dia: "Day",
  día: "Day",
  "por dia": "Day",
  "por día": "Day",
  flat: "Flat",
  fijo: "Flat",
};

/** The rate type a rate_type cell names, in English or Spanish, or null. */
export function rateTypeOf(cell: string): RateBasis | null {
  return RATE_TYPE_WORDS[cell.trim().toLowerCase()] ?? null;
}
