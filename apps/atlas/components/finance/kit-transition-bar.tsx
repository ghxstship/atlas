"use client";

import { TransitionButton } from "./kit-transition-button";
import { useFinanceT } from "./kit-use-finance-t";
import { type Lifecycle } from "./kit.types";

/** The transitions a state allows, as buttons; approvals lead as the primary action. */
export function TransitionBar({
  org,
  lifecycle,
  id,
  state,
  allowed,
}: {
  org: string;
  lifecycle: Lifecycle;
  id: string;
  state: string;
  allowed: readonly string[];
}) {
  const t = useFinanceT();
  if (allowed.length === 0) return null;
  const tone = (next: string) =>
    ["Approved", "Posted", "Priced", "Issued", "Closed"].includes(next)
      ? "primary"
      : ["Rejected", "Canceled", "Disputed"].includes(next)
        ? "danger"
        : "secondary";
  return (
    <div role="group" aria-label={t("common.actions")} className="flex flex-wrap gap-8">
      {allowed.map((next) => (
        <TransitionButton
          key={next}
          org={org}
          lifecycle={lifecycle}
          id={id}
          expected={state}
          next={next}
          variant={tone(next)}
        />
      ))}
    </div>
  );
}
