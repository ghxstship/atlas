import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Money } from "../Forms/Forms.tsx";
import { type PaymentTrackerProps } from "./Gateway.types.ts";

/** A payment followed like a package: Submitted, Approved, Scheduled, Paid. */
export function PaymentTracker({
  invoiceKey,
  title,
  amount,
  current,
  dates,
  expected,
}: PaymentTrackerProps): ReactElement {
  const t = useT();
  const steps = [t("pay.submitted"), t("pay.approved"), t("pay.scheduled"), t("pay.paid")];
  return (
    <section
      aria-label={t("pay.label", { key: invoiceKey })}
      className="flex flex-col gap-16 w-(--ui-alert) max-w-full p-16 box-border rounded-card border border-border-subtle bg-bg-raised"
    >
      <div className="flex items-start justify-between gap-8">
        <div className="flex flex-col">
          <span className="font-mono text-text-12 text-text-secondary">{invoiceKey}</span>
          <strong className="font-semibold">{title}</strong>
        </div>
        <strong className="text-heading-20 font-semibold tabular-nums">
          <Money amount={amount} />
        </strong>
      </div>
      <ol className="grid grid-cols-4 gap-8 m-0 p-0 list-none">
        {steps.map((s, i) => {
          const state = i < current ? "done" : i === current ? "current" : "todo";
          const note =
            dates[i] ??
            (state === "todo" && expected && i === current + 1
              ? t("pay.expected", { date: expected })
              : "");
          return (
            <li
              key={s}
              aria-current={state === "current" ? "step" : undefined}
              className={cx(
                "flex flex-col gap-6 pt-4 text-text-12 border-t-stroke-accent",
                state === "done" && "border-t-success",
                state === "current" && "border-t-accent font-medium",
                state === "todo" && "border-t-border-subtle text-text-secondary",
              )}
            >
              <span
                className={cx(
                  "inline-grid place-items-center size-icon-20 rounded-full text-text-11 font-semibold tabular-nums",
                  state === "todo" &&
                    "ring-(length:--stroke-width-hairline) ring-inset ring-border-strong",
                  state === "current" && "bg-accent text-accent-text-on",
                  state === "done" && "bg-bg-hover text-success",
                )}
              >
                {state === "done" ? <Icon name="Check" size={12} /> : i + 1}
              </span>
              <span>{s}</span>
              <span className="text-text-secondary tabular-nums">{note}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
