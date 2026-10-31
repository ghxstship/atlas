/**
 * The tie-out of extracted line items against the totals a document prints (B15, parity gap G-225).
 * Deterministic code, never the model: the server computes it for invoice and receipt extraction
 * and the Atlas panel computes it again on every edit. No zod and no model code, so the panel can
 * import it. The residual is advisory: it never blocks a write in the database (ADR 0154).
 */

export interface TieOutLine {
  /** Quantity as read or edited; null when unread. */
  readonly quantity: number | string | null;
  /** Unit price in minor units; null when the line is unpriced (NO_ANSWER). */
  readonly unitPriceMinor: number | null;
}

export interface TieOutPrinted {
  readonly subtotal?: number | null;
  readonly tax?: number | null;
  readonly shipping?: number | null;
  readonly tip?: number | null;
  readonly total?: number | null;
}

export interface TieOut {
  /** Sum of the priced lines' extended amounts. */
  readonly linesMinor: number;
  /** Printed subtotal minus the lines, or null when no subtotal is printed. */
  readonly subtotalResidualMinor: number | null;
  /** Printed total minus (lines + tax + shipping + tip), or null when no total is printed. */
  readonly totalResidualMinor: number | null;
  /** Positions (0-based) of lines without a price or quantity. */
  readonly unpricedLines: readonly number[];
  /** ties: the total is met exactly; residual: it is not; incomplete: the total or a price is unread. */
  readonly status: "ties" | "residual" | "incomplete";
}

/** A decimal as an integer and its scale: "1.25" is { digits: 125n, scale: 2 }. */
function decimal(value: number | string): { digits: bigint; scale: number } | null {
  const text = typeof value === "number" ? numberText(value) : value.trim();
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const fraction = match[3] ?? "";
  const digits = BigInt(`${match[2] ?? "0"}${fraction}`);
  return { digits: match[1] ? -digits : digits, scale: fraction.length };
}

/** A number written without exponent, so 1e-7 reads as 0.0000001. */
function numberText(value: number): string {
  if (!Number.isFinite(value)) return "NaN";
  const plain = String(value);
  if (!/e/i.test(plain)) return plain;
  return value.toFixed(20).replace(/\.?0+$/, "");
}

/**
 * Quantity times unit price in minor units, rounded half away from zero, exactly as
 * private.extended_minor rounds a numeric (0321). Exact decimal arithmetic, so 1.005 x 100 is 101,
 * and -2.5 x 1 is -3. Null when either is unread.
 */
export function extendedMinor(
  quantity: number | string | null,
  unitPriceMinor: number | null,
): number | null {
  if (quantity === null || unitPriceMinor === null || !Number.isInteger(unitPriceMinor))
    return null;
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

const known = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isInteger(value);

/** Lines against the printed subtotal and total. Tax, shipping and tip count only when printed. */
export function computeTieOut(input: {
  readonly lines: readonly TieOutLine[];
  readonly printed: TieOutPrinted;
}): TieOut {
  let linesMinor = 0;
  const unpricedLines: number[] = [];
  input.lines.forEach((line, i) => {
    const amount = extendedMinor(line.quantity, line.unitPriceMinor);
    if (amount === null) unpricedLines.push(i);
    else linesMinor += amount;
  });
  const { subtotal, tax, shipping, tip, total } = input.printed;
  const extras = [tax, shipping, tip].reduce<number>((sum, v) => sum + (known(v) ? v : 0), 0);
  const subtotalResidualMinor = known(subtotal) ? subtotal - linesMinor : null;
  const totalResidualMinor = known(total) ? total - (linesMinor + extras) : null;
  const status =
    totalResidualMinor === null || unpricedLines.length > 0
      ? "incomplete"
      : totalResidualMinor === 0
        ? "ties"
        : "residual";
  return { linesMinor, subtotalResidualMinor, totalResidualMinor, unpricedLines, status };
}

/** The share a price differs from a reference, for the variance badge (0.1 is 10 percent). */
export function priceVariance(price: number | null, reference: number | null): number | null {
  if (!known(price) || !known(reference) || reference === 0) return null;
  return Math.abs(price - reference) / Math.abs(reference);
}

/** The variance at or above which a line's price is badged against its history. */
export const VARIANCE_BADGE = 0.1;
