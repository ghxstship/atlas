import { type ReactElement } from "react";
import { useFormat, useT } from "../lib/context.tsx";
import { type MoneyProps } from "./Forms.types.ts";

/** An amount with tabular numerals, or Unpriced when null. A blank price is Unpriced; a zero is a claim. */
export function Money({ amount, currency, unpricedLabel }: MoneyProps): ReactElement {
  const t = useT();
  const fmt = useFormat();
  if (amount === null || amount === undefined) {
    return (
      <span className="text-text-secondary not-italic">{unpricedLabel ?? t("money.unpriced")}</span>
    );
  }
  return <span className="tabular-nums">{fmt.currency(amount, currency)}</span>;
}
