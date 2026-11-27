import { type ReactElement } from "react";
import { type PlanLimitsProps } from "./Marketing.types.ts";

/**
 * Label and value rows, the value in tabular figures at the row's end: the limits of a plan in
 * PricingTable, and any short list of named amounts on a public page.
 */
export function PlanLimits({ limits }: PlanLimitsProps): ReactElement {
  return (
    <dl className="xos-mkt-plan-limits">
      {limits.map((limit) => (
        <div key={limit.label}>
          <dt>{limit.label}</dt>
          <dd className="tabular-nums">{limit.value}</dd>
        </div>
      ))}
    </dl>
  );
}
