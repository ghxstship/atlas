import { type ReactElement } from "react";
import { marketingCopy } from "./marketing-copy.ts";
import { type PriceDisplayProps } from "./Marketing.types.ts";

/**
 * One price with its billing period and tax label. A null amount is unpriced and renders Quoted,
 * never zero; a plan sold by quote shows its starting price with "From". Whole amounts print
 * without decimals.
 */
export function PriceDisplay({
  amount,
  currency = "USD",
  period,
  taxMode,
  from = false,
  locale,
  messages,
}: PriceDisplayProps): ReactElement {
  const copy = marketingCopy({ locale, messages });
  const { t } = copy;
  const unpriced = amount === null || amount === undefined;
  const digits = unpriced || Math.round(amount) === amount ? 0 : 2;
  const money = unpriced
    ? null
    : new Intl.NumberFormat(copy.locale, {
        style: "currency",
        currency,
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(amount);
  return (
    <p className="xos-mkt-price">
      <span className="xos-mkt-price-amount tabular-nums">
        {money === null ? (
          <span className="text-text-secondary not-italic">{t("mk.price.quoted")}</span>
        ) : from ? (
          t("mk.price.from", { price: money })
        ) : (
          money
        )}
      </span>
      {money !== null && period ? (
        <span className="xos-mkt-price-period">
          {t(period === "year" ? "mk.price.perYear" : "mk.price.perMonth")}
        </span>
      ) : null}
      {taxMode ? (
        <span className="xos-mkt-price-tax">
          {t(taxMode === "inclusive" ? "mk.price.taxInclusive" : "mk.price.taxExclusive", {
            currency,
          })}
        </span>
      ) : null}
    </p>
  );
}
