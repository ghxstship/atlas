import type { createFormatter } from "next-intl";
import type { Translate } from "@/lib/shell/translate";

/** next-intl's formatter, as getFormatter and useFormatter return it. */
type NumberFormatter = Pick<ReturnType<typeof createFormatter>, "number">;

/**
 * An amount in minor units for display (Section 3.7): masked Restricted values say Masked, a null
 * amount says Unpriced (never 0), and everything else is formatted in its currency.
 */
export function money(
  format: NumberFormatter,
  t: Translate,
  minor: number | null,
  currency: string,
  masked = false,
  exponent = 2,
): string {
  if (masked) return t("crew.money.masked");
  if (minor === null) return t("crew.money.unpriced");
  return format.number(minor / 10 ** exponent, { style: "currency", currency });
}
