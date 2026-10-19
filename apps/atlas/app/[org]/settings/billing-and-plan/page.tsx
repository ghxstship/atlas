import { getSeatUsage, getSubscription } from "@xos/data";
import { getFormatter, getTranslations } from "next-intl/server";
import { SectionHeader } from "@/components/settings/section-header";
import { requireNode } from "@/lib/shell/require-node";
import { Button, Card, InlineAlert } from "@/components/ui";
import { ADDONS, OFFERS, PLANS } from "@/lib/plans.generated";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Billing and Plan (Section 16, Section 4.5.6 item 36; Owner only). Shows the current plan and its seat
 * usage, the plans of packages/schemas/plans.yaml with their prices, seats, extra-seat prices, limits
 * and features, and the Aurora request pack (ADR 0034). Subscribing, buying extra seats and buying a
 * pack run through Stripe (@xos/platform billing); their buttons stay disabled until Atlas is connected
 * to billing. Enterprise is sold by quote and never checks out.
 */
export default async function BillingSettingsPage({
  params,
}: PageProps<"/[org]/settings/billing-and-plan">) {
  const ctx = await requireNode("settings.billing-and-plan", await params);
  const [subscription, seats, t, tp, translate, format] = await Promise.all([
    getSubscription(ctx.viewer.db, ctx.org.id),
    getSeatUsage(ctx.viewer.db, ctx.org.id),
    getTranslations("shell.settings.billing"),
    getTranslations("shell.plans"),
    getTranslate(),
    getFormatter(),
  ]);
  if (!subscription.ok) {
    throw new Error(`Cannot read the subscription: ${JSON.stringify(subscription.error)}`);
  }
  if (!seats.ok) {
    throw new Error(`Cannot read the seat usage: ${JSON.stringify(seats.error)}`);
  }
  const current = subscription.data.planCode;
  const usage = seats.data;
  const name = (code: string) => translate(`shell.plans.${code}.name`);
  const usd = (minor: number) =>
    format.number(minor / 100, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: minor % 100 === 0 ? 0 : 2,
    });
  const full = usage.limit !== null && usage.used >= usage.limit;
  const pack = ADDONS.find((a) => a.limit === "aurora_requests_per_month");
  const founding = OFFERS.find((o) => o.code === "founding_customer");
  return (
    <>
      <SectionHeader node="settings.billing-and-plan" />
      <p className="m-0 text-text-14">{t("current", { org: ctx.org.name, plan: name(current) })}</p>
      <InlineAlert tone="info">{t("notAvailable")}</InlineAlert>
      <Card>
        <div className="flex flex-col gap-8">
          <h2 className="m-0 text-heading-16 font-semibold">{t("seats")}</h2>
          <p className="m-0 text-text-14">
            {usage.limit === null
              ? t("seatUsageUnlimited", { used: usage.used })
              : t("seatUsage", {
                  used: format.number(usage.used),
                  limit: format.number(usage.limit),
                })}
          </p>
          {usage.extraSeats > 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">
              {t("extraSeats", { count: usage.extraSeats })}
            </p>
          ) : null}
          {usage.grandfathered ? (
            <p className="m-0 text-text-13 text-text-secondary">{t("grandfathered")}</p>
          ) : null}
          {full ? (
            <InlineAlert tone="warning">
              {usage.sellsExtraSeats ? t("seatsFull") : t("seatsFullUpgrade")}
            </InlineAlert>
          ) : null}
          {usage.sellsExtraSeats ? (
            <div>
              <Button variant="secondary" disabled>
                {t("buySeats")}
              </Button>
            </div>
          ) : null}
        </div>
      </Card>
      <ul className="m-0 grid list-none grid-cols-1 gap-12 p-0">
        {PLANS.map((plan) => (
          <li key={plan.code}>
            <Card>
              <div className="flex flex-col gap-8">
                <div className="flex flex-wrap items-baseline justify-between gap-8">
                  <h2 className="m-0 text-heading-16 font-semibold">{name(plan.code)}</h2>
                  <span className="text-text-13 text-text-secondary">
                    {plan.free
                      ? tp("free")
                      : plan.usdQuoteFromMonthlyMinor !== null
                        ? tp("quoteFrom", { price: usd(plan.usdQuoteFromMonthlyMinor) })
                        : plan.usdMonthlyMinor === null
                          ? tp("unpriced")
                          : t("perMonth", { price: usd(plan.usdMonthlyMinor) })}
                  </span>
                </div>
                {plan.usdAnnualMinor !== null && !plan.free ? (
                  <p className="m-0 text-text-13 text-text-secondary">
                    {t("perYear", { price: usd(plan.usdAnnualMinor) })}
                  </p>
                ) : null}
                <p className="m-0 text-text-13 text-text-secondary">
                  {translate(`shell.plans.${plan.code}.audience`)}
                </p>
                <ul className="m-0 flex list-none flex-col gap-2 p-0 text-text-13">
                  <li>
                    {plan.limits["seats"] === null || plan.limits["seats"] === undefined
                      ? tp("seatsUnlimited")
                      : tp("seatsIncluded", { count: plan.limits["seats"] })}
                  </li>
                  {plan.usdExtraSeatMonthlyMinor !== null ? (
                    <li>{tp("extraSeat", { price: usd(plan.usdExtraSeatMonthlyMinor) })}</li>
                  ) : plan.free ? (
                    <li className="text-text-secondary">{tp("noExtraSeats")}</li>
                  ) : null}
                  {plan.limits["field_members"] === null ? (
                    <li>{tp("fieldCrewUnlimited")}</li>
                  ) : null}
                </ul>
                <dl className="m-0 grid grid-cols-2 gap-4 text-text-12">
                  {Object.entries(plan.limits).map(([limit, value]) => (
                    <div key={limit} className="contents">
                      <dt className="text-text-secondary">
                        {translate(`shell.plans.limits.${limit}`)}
                      </dt>
                      <dd className="m-0">
                        {value === null ? tp("unlimited") : format.number(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
                {plan.adds.length > 0 ? (
                  <div className="flex flex-col gap-4 text-text-12">
                    {plan.extends ? (
                      <span className="text-text-secondary">
                        {tp("includesPrevious", { plan: name(plan.extends) })}
                      </span>
                    ) : null}
                    <ul className="m-0 ps-16">
                      {plan.adds.map((f) => (
                        <li key={f}>{translate(`shell.plans.features.${f}`)}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <div>
                  {plan.code === current ? (
                    <span className="text-label-13 font-medium text-success-text">
                      {tp("current")}
                    </span>
                  ) : plan.selfServe || plan.free ? (
                    <Button variant="secondary" disabled>
                      {t("choose", { plan: name(plan.code) })}
                    </Button>
                  ) : (
                    <Button variant="secondary" disabled>
                      {t("contactSales")}
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          </li>
        ))}
      </ul>
      {pack ? (
        <Card>
          <div className="flex flex-col gap-8">
            <h2 className="m-0 text-heading-16 font-semibold">{t("auroraPack.title")}</h2>
            <p className="m-0 text-text-14">
              {t("auroraPack.body", {
                amount: format.number(pack.amount),
                price: usd(pack.usdMinor),
              })}
            </p>
            <div>
              <Button variant="secondary" disabled>
                {t("auroraPack.buy")}
              </Button>
            </div>
          </div>
        </Card>
      ) : null}
      <p className="m-0 text-text-12 text-text-secondary">{t("pricesInUsd")}</p>
      {founding ? (
        <p className="m-0 text-text-12 text-text-secondary">
          {t("foundingOffer", {
            count: founding.maxRedemptions,
            percent: founding.percentOff,
            months: founding.durationMonths,
            code: founding.promotionCode,
          })}
        </p>
      ) : null}
    </>
  );
}
