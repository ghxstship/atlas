/**
 * The deterministic rules of Aurora's intakes (B15, RRR-239): how a printed name or act is compared,
 * how a party is preselected, how lines tie out against a printed total, and which year a date
 * printed without one means. Code, never the model: the server runs them on what it reads and the
 * Atlas panels run them again on every edit. No zod and no model code, so a panel can import this
 * without the rest of Aurora.
 */

const foldAccents = (text: string) => text.normalize("NFKD").replace(/[̀-ͯ]/g, "");

const words = (text: string) =>
  foldAccents(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const TITLES = new Set(["mr", "mrs", "ms", "miss", "mx", "dr", "prof", "sir", "madam", "mstr"]);

const withoutTitles = (text: string) =>
  words(text)
    .split(" ")
    .filter((w) => w !== "" && !TITLES.has(w))
    .join(" ");

/**
 * A person's name as the review compares it: case and accents folded, titles removed, and the
 * airline form "LAST/FIRST MR" and the list form "Last, First" turned around, so each of them equals
 * "first last".
 */
export function normalizePersonName(name: string): string {
  const split = /^([^/,]+)[/,](.+)$/.exec(name.trim());
  if (split) return `${withoutTitles(split[2] ?? "")} ${withoutTitles(split[1] ?? "")}`.trim();
  return withoutTitles(name);
}

/**
 * An act's name as the review groups it: case and punctuation folded, a leading "the" dropped, and
 * a "feat." or "f/s/o" tail removed. Two documents are of one act only when these are equal.
 */
export function normalizeAct(name: string): string {
  return words(
    foldAccents(name)
      .toLowerCase()
      .replace(/\b(?:feat\.?|ft\.?|featuring|f\s*\/\s*s\s*\/\s*o)(?=[\s(]|$).*$/, " ")
      .replace(/\((?:dj\s*set|live)\)/g, " "),
  ).replace(/^the\s+/, "");
}

/**
 * The candidate id only when exactly one candidate matches exactly; otherwise null. There is no
 * fuzzy preselection anywhere: a near match is for the person to choose.
 */
export function matchExact(
  normalized: string,
  candidates: readonly { readonly id: string; readonly normalized: string }[],
): string | null {
  if (normalized === "") return null;
  const ids = new Set(candidates.filter((c) => c.normalized === normalized).map((c) => c.id));
  return ids.size === 1 ? ([...ids][0] ?? null) : null;
}

/** A decimal as an integer and its scale: "1.25" is { digits: 125n, scale: 2 }. */
function decimal(value: number | string): { digits: bigint; scale: number } | null {
  const text =
    typeof value === "number"
      ? Number.isFinite(value)
        ? /e/i.test(String(value))
          ? value.toFixed(20).replace(/\.?0+$/, "")
          : String(value)
        : ""
      : value.trim();
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const fraction = match[3] ?? "";
  const digits = BigInt(`${match[2] ?? "0"}${fraction}`);
  return { digits: match[1] ? -digits : digits, scale: fraction.length };
}

/**
 * Quantity times unit price in minor units, rounded half away from zero, exactly as
 * private.extended_minor rounds a numeric (0321). Decimal strings and BigInt, so 1.005 x 100 is 101
 * where floats give 100. Null when either is unread.
 */
export function extendedMinor(
  quantity: number | string | null,
  unitPriceMinor: number | null,
): number | null {
  if (quantity === null || unitPriceMinor === null || !Number.isInteger(unitPriceMinor)) {
    return null;
  }
  const q = decimal(quantity);
  if (!q) return null;
  const product = q.digits * BigInt(unitPriceMinor);
  if (q.scale === 0) return Number(product);
  const unit = 10n ** BigInt(q.scale);
  const negative = product < 0n;
  const magnitude = negative ? -product : product;
  let whole = magnitude / unit;
  if ((magnitude % unit) * 2n >= unit) whole += 1n;
  return Number(negative ? -whole : whole);
}

export interface TieOutLine {
  readonly quantity: number | string | null;
  /** Null when the line has no price. */
  readonly unitPriceMinor: number | null;
}

/** What keeps a tie-out from being checked: an unpriced line (numbered from 1), or no printed total. */
export type TieOutMissing =
  | { readonly field: "unit_price_minor"; readonly line: number }
  | { readonly field: "printed_total_minor" };

export interface TieOutResult {
  /** Sum of the priced lines. */
  readonly computedSubtotalMinor: number;
  /** The subtotal plus the printed tax, when one was given. */
  readonly computedTotalMinor: number;
  /** Printed total minus computed total; null when not checkable. */
  readonly residualMinor: number | null;
  readonly printedSubtotalMinor: number | null;
  readonly printedTaxMinor: number | null;
  readonly printedTotalMinor: number | null;
  readonly status: "ties" | "residual" | "not_checkable";
  readonly missing: readonly TieOutMissing[];
}

/**
 * Lines against a printed total. Tolerance is exactly zero. A line with no price, or no printed
 * total, gives not_checkable with what is missing. It never blocks a write in the database.
 */
export function tieOut(input: {
  readonly lines: readonly TieOutLine[];
  readonly printedSubtotalMinor?: number | null;
  readonly printedTaxMinor?: number | null;
  readonly printedTotalMinor?: number | null;
}): TieOutResult {
  const printedTotalMinor = input.printedTotalMinor ?? null;
  const printedTaxMinor = input.printedTaxMinor ?? null;
  const missing: TieOutMissing[] = [];
  let computedSubtotalMinor = 0;
  input.lines.forEach((line, i) => {
    const amount = extendedMinor(line.quantity, line.unitPriceMinor);
    if (amount === null) missing.push({ field: "unit_price_minor", line: i + 1 });
    else computedSubtotalMinor += amount;
  });
  if (printedTotalMinor === null) missing.push({ field: "printed_total_minor" });
  const computedTotalMinor = computedSubtotalMinor + (printedTaxMinor ?? 0);
  const residualMinor =
    missing.length === 0 && printedTotalMinor !== null
      ? printedTotalMinor - computedTotalMinor
      : null;
  return {
    computedSubtotalMinor,
    computedTotalMinor,
    residualMinor,
    printedSubtotalMinor: input.printedSubtotalMinor ?? null,
    printedTaxMinor,
    printedTotalMinor,
    status: residualMinor === null ? "not_checkable" : residualMinor === 0 ? "ties" : "residual",
    missing,
  };
}

/** The pay basis a fee printed as a total can be carried on: an engagement's rate is per unit. */
export const FLAT_FEE = "Flat Fee";

/**
 * The fee a contract review prefills: the printed fee only on a Flat Fee row. On any other basis the
 * total is shown and not carried, because it would become a rate per day or per unit.
 */
export function prefilledFee(
  payBasis: string | null,
  printedFeeMinor: number | null,
): number | null {
  return payBasis === FLAT_FEE ? printedFeeMinor : null;
}

const isRealDay = (year: number, month: number, day: number) => {
  const at = new Date(Date.UTC(year, month - 1, day));
  return at.getUTCMonth() === month - 1 && at.getUTCDate() === day;
};

/**
 * The first date with this month and day on or after `today` (YYYY-MM-DD), for a date printed
 * without a year: its calendar's next occurrence, as YYYY-MM-DD. Null when no year makes it a date.
 * Pass the project's own today, never a UTC day.
 */
export function inferYear(month: number, day: number, today: string): string | null {
  const start = Number(today.slice(0, 4));
  for (let year = start; year <= start + 8; year += 1) {
    if (!isRealDay(year, month, day)) continue;
    const text = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (text >= today) return text;
  }
  return null;
}

/**
 * True for a time zone the database's private.assert_time_zone also takes: an Area/Location name, or
 * UTC. Intl alone takes "+05:00" and "EST", which that check may refuse, and one refusal rolls back
 * a whole batch, so those are not zones here.
 */
export function isAreaTimeZone(zone: string): boolean {
  if (zone !== "UTC" && !/^[A-Z][A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(zone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
