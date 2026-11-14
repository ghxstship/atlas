"use client";

import { useState, type CSSProperties, type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useLocale, useMessages, useT } from "../lib/context.tsx";
import { SegmentedControl } from "../Navigation/SegmentedControl.tsx";
import { cardClass } from "../Surface/Surface.tsx";
import { ButtonLink } from "./ButtonLink.tsx";
import { MarketingPoints } from "./MarketingPoints.tsx";
import { PriceDisplay } from "./PriceDisplay.tsx";
import { type PricingTableProps } from "./Marketing.types.ts";

/**
 * Plans side by side. The billing toggle announces its change, the terms sit with the plans, and
 * no plan is preselected. A plan with no price for the period is unpriced and reads Quoted.
 */
export function PricingTable({
  periods,
  period,
  currency,
  taxMode,
  plans,
  terms,
  onChange,
}: PricingTableProps): ReactElement {
  const t = useT();
  const locale = useLocale();
  const messages = useMessages();
  const [selected, setSelected] = useState(period ?? periods[0]?.value ?? "");
  const [announcement, setAnnouncement] = useState("");
  const current = periods.find((p) => p.value === selected) ?? periods[0];

  const change = (next: string) => {
    setSelected(next);
    const chosen = periods.find((p) => p.value === next);
    if (chosen) setAnnouncement(t("mk.pricing.changed", { period: chosen.label }));
    onChange?.(next);
  };

  return (
    <div className="xos-mkt-pricing">
      <div className="xos-mkt-pricing-bar">
        <SegmentedControl
          label={t("mk.pricing.period")}
          value={selected}
          options={periods.map((p) => ({ value: p.value, label: p.label }))}
          onChange={change}
        />
        {periods.map((p) =>
          p.note ? (
            <span key={p.value} className="xos-mkt-note">
              {p.note}
            </span>
          ) : null,
        )}
        <span className="sr-only" role="status" aria-live="polite">
          {announcement}
        </span>
      </div>
      <ul className="xos-mkt-plans" style={{ "--xos-mkt-n": plans.length } as CSSProperties}>
        {plans.map((plan) => {
          const quoted = plan.quoteFrom !== undefined;
          const amount = plan.quoteFrom ?? plan.prices?.[selected] ?? null;
          const free = amount === 0;
          return (
            <li
              key={plan.name}
              className={cx(cardClass, "xos-mkt-plan", plan.recommended && "xos-mkt-plan-rec")}
            >
              <div className="xos-mkt-plan-head">
                <h3>{plan.name}</h3>
                {plan.recommended ? (
                  <span className="xos-mkt-tag">{t("mk.pricing.recommended")}</span>
                ) : null}
              </div>
              <p className="xos-mkt-plan-blurb">{plan.blurb}</p>
              <PriceDisplay
                amount={amount}
                from={quoted}
                period={free ? null : quoted ? "month" : (current?.unit ?? null)}
                taxMode={free ? null : (taxMode ?? null)}
                locale={locale}
                messages={messages}
                {...(currency === undefined ? {} : { currency })}
              />
              {plan.note ? <p className="xos-mkt-note">{plan.note}</p> : null}
              {plan.cta ? (
                <ButtonLink
                  href={plan.cta.href}
                  variant={plan.recommended ? "primary" : "secondary"}
                  size="xl"
                  className="xos-mkt-plan-cta"
                >
                  {plan.cta.label}
                </ButtonLink>
              ) : null}
              {plan.limits ? (
                <dl className="xos-mkt-plan-limits">
                  {plan.limits.map((limit) => (
                    <div key={limit.label}>
                      <dt>{limit.label}</dt>
                      <dd className="tabular-nums">{limit.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {plan.features ? (
                <div className="xos-mkt-plan-features">
                  {plan.featuresTitle ? (
                    <p className="xos-mkt-label">{plan.featuresTitle}</p>
                  ) : null}
                  <MarketingPoints points={plan.features} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {terms ? <p className="xos-mkt-note xos-mkt-pricing-terms">{terms}</p> : null}
    </div>
  );
}
