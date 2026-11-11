import { getSeatUsage, getSubscription } from "@xos/data";
import {
  getBillingAccount,
  getStripeCancellations,
  orgCheckoutCurrency,
  type BillingAccount,
} from "@xos/data/billing";
import { planFeatureOffered } from "@xos/i18n/offering";
import type { Route } from "next";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { BillingLifecycleNotice } from "@/components/lifecycle/billing-notice";
import { ContributedPanels } from "@/components/settings/contributed-panels";
import { SectionHeader } from "@/components/settings/section-header";
import {
  BillingPortalButton,
  EndPlanForm,
  RenewalConsentForm,
} from "@/components/settings/billing-forms";
import { StripeCancellationNotice } from "@/components/settings/stripe-cancellation-notice";
import { requireNode } from "@/lib/shell/require-node";
import { Button, ButtonLink, Card, InlineAlert } from "@/components/ui";
import { renewalWording } from "@/lib/billing/renewal-terms";
import { billingStatus } from "@/lib/billing/stripe";
import { currentOffering } from "@/lib/offering";
import { ADDONS, OFFERS, PLANS } from "@/lib/plans.generated";
import { getOrgTimeZone } from "@/lib/shell/time-zone";
import { getTranslate } from "@/lib/shell/translate";

/** Refusals that keep an org from Checkout whatever plan it chooses, shown instead of the plan buttons. */
const STANDING_REFUSALS = [
  "billing_through_partner",
  "sandbox_not_billable",
  "org_read_only",
] as const;

/**
 * Billing and Plan (Section 16, Section 4.5.6 item 36; Owner only). Shows the current plan and its seat
 * usage, the plans of packages/schemas/plans.yaml with their prices, seats, extra-seat prices, limits
 * and features, and the Aurora request pack (ADR 0035).
 *
 * ADR 0033 decision 59: XOS launches on the trial and the Access plan, and billing opens once the
 * owner sets the Stripe key. An org on a trial or Access chooses a self-serve plan and term and pays in
 * Stripe Checkout; an org that pays through Stripe changes its plan or card in the Stripe customer portal. ADR 0161:
 * choosing a plan first shows its renewal terms (price, term, first charge date and how to cancel), and only agreeing to
 * them opens Checkout. A paying org ends its plan here with one button, and the page says what Stripe has said about it.
 * While a paid checkout waits for its subscription to sync, the page says Stripe is confirming
 * and offers no second Checkout. Checkout is offered only where the database would open it (migration 904100201): a
 * client org its partner bills, a sandbox and a read-only org see why instead. Coming back from a Checkout that
 * carried the trial over, the page says the card is saved, since nothing is charged before the trial ends. Until the
 * key is set the page says billing is not open yet, and the buttons answer the same. Buying extra seats and packs
 * stays disabled; Enterprise is sold by quote and never checks out.
 * Panels other modules contribute follow, such as A107's choice of what stays writable over the plan's limits.
 */
export default async function BillingSettingsPage({
  params,
  searchParams,
}: PageProps<"/[org]/settings/billing-and-plan">) {
  const routeParams = await params;
  const ctx = await requireNode("settings.billing-and-plan", routeParams);
  const search = await searchParams;
  const billing = billingStatus();
  const [
    subscription,
    seats,
    account,
    t,
    tp,
    translate,
    format,
    word,
    zone,
    cancellations,
    currency,
  ] = await Promise.all([
    getSubscription(ctx.viewer.db, ctx.org.id),
    getSeatUsage(ctx.viewer.db, ctx.org.id),
    billing.open ? getBillingAccount(ctx.viewer.db, ctx.org.id, billing.livemode) : null,
    getTranslations("shell.settings.billing"),
    getTranslations("shell.plans"),
    getTranslate(),
    getFormatter(),
    renewalWording(),
    getOrgTimeZone(ctx),
    getStripeCancellations(ctx.viewer.db, ctx.org.id),
    // The currency Checkout charges in (ADR 0160), so the terms shown are the terms the action words again.
    orgCheckoutCurrency(ctx.viewer.db, ctx.org.id),
  ]);
  if (!subscription.ok) {
    throw new Error(`Cannot read the subscription: ${JSON.stringify(subscription.error)}`);
  }
  if (!seats.ok) {
    throw new Error(`Cannot read the seat usage: ${JSON.stringify(seats.error)}`);
  }
  if (account !== null && !account.ok) {
    throw new Error(`Cannot read the billing account: ${JSON.stringify(account.error)}`);
  }
  const stripe: BillingAccount | null = account?.ok ? account.data : null;
  const paid = stripe?.paidThroughStripe === true;
  const awaiting = stripe?.awaitingSubscription === true;
  // The rule that refuses every plan's Checkout for the org now (904100201); paying and awaiting are among its rules.
  const refusal = stripe?.checkoutRefusal ?? null;
  const buying = billing.open && stripe !== null && refusal === null;
  // Only a standing refusal is explained here; any other (an org that no longer exists) shows no alert before a click.
  const standing =
    billing.open && !paid && !awaiting ? STANDING_REFUSALS.find((r) => r === refusal) : undefined;
  const current = subscription.data.planCode;
  const trialing = subscription.data.state === "trialing";
  const term = search["term"] === "annual" ? "Annual" : "Monthly";
  const checkout =
    search["checkout"] === "done" ||
    search["checkout"] === "trial" ||
    search["checkout"] === "canceled"
      ? search["checkout"]
      : null;
  const usage = seats.data;
  const org = ctx.org.slug;
  const page = `/${org}/settings/billing-and-plan`;
  const reviewCode = typeof search["review"] === "string" ? search["review"] : null;
  const review =
    buying && reviewCode !== null
      ? word({
          planCode: reviewCode,
          interval: term,
          currency,
          trialEndsAt: subscription.data.trialEndsAt,
          zone,
        })
      : null;
  const ending = cancellations.ok && cancellations.data.some((c) => c.mode === "At Period End");
  const name = (code: string) => translate(`shell.plans.${code}.name`);
  const usd = (minor: number) =>
    format.number(minor / 100, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: minor % 100 === 0 ? 0 : 2,
    });
  const full = usage.limit !== null && usage.used >= usage.limit;
  // Only the currencies of open territories are mentioned (ADR 0160).
  const offering = await currentOffering();
  const otherCurrencies = offering.currencies.filter((c) => c !== "USD");
  const pack = ADDONS.find((a) => a.limit === "aurora_requests_per_month");
  const founding = OFFERS.find((o) => o.code === "founding_customer");
  return (
    <>
      <SectionHeader node="settings.billing-and-plan" />
      <BillingLifecycleNotice
        ctx={ctx}
        billing={{
          open: billing.open,
          portal: stripe?.hasStripeCustomer === true,
          awaiting,
          reviewing: review !== null,
          checkout: buying,
        }}
      />
      <p className="m-0 text-text-14">{t("current", { org: ctx.org.name, plan: name(current) })}</p>
      <StripeCancellationNotice ctx={ctx} />
      {billing.open ? null : <InlineAlert tone="info">{t("notAvailable")}</InlineAlert>}
      {standing ? <InlineAlert tone="info">{t(`refusals.${standing}`)}</InlineAlert> : null}
      {checkout === "done" && paid ? (
        <InlineAlert tone="success">
          {t("checkoutDone", { org: ctx.org.name, plan: name(current) })} {t("checkoutTerms")}
        </InlineAlert>
      ) : checkout === "trial" && paid ? (
        <InlineAlert tone="success">
          {t("checkoutTrialDone", { org: ctx.org.name, plan: name(current) })} {t("checkoutTerms")}
        </InlineAlert>
      ) : checkout === "done" || checkout === "trial" || awaiting ? (
        <InlineAlert tone="success">{t("checkoutPending")}</InlineAlert>
      ) : checkout === "canceled" ? (
        <InlineAlert tone="info">{t("checkoutCanceled")}</InlineAlert>
      ) : null}
      {review ? (
        <Card>
          <section aria-labelledby="renewal-review" className="flex flex-col gap-8">
            <h2 id="renewal-review" className="m-0 text-heading-16 font-semibold">
              {t("renewal.title", { plan: name(review.planCode) })}
            </h2>
            <p className="m-0 text-text-14" data-testid="renewal-statement">
              {review.statement}
            </p>
            <RenewalConsentForm
              org={org}
              plan={review.planCode}
              interval={review.interval}
              hash={review.hash}
              label={t("renewal.continue")}
            />
            <div>
              <Link
                href={(term === "Annual" ? `${page}?term=annual` : page) as Route}
                className="text-text-13 text-text-secondary underline"
              >
                {t("renewal.back")}
              </Link>
            </div>
          </section>
        </Card>
      ) : null}
      {stripe?.hasStripeCustomer ? (
        <Card>
          <section aria-labelledby="billing-portal" className="flex flex-col gap-8">
            <h2 id="billing-portal" className="m-0 text-heading-16 font-semibold">
              {t("portal.title")}
            </h2>
            <p className="m-0 text-text-14">{paid ? t("portal.body") : t("portal.bodyEnded")}</p>
            {paid && stripe.interval !== null && stripe.currentPeriodEnd !== null ? (
              <p className="m-0 text-text-13 text-text-secondary">
                {t("portal.period", {
                  term: stripe.interval,
                  date: format.dateTime(new Date(stripe.currentPeriodEnd), { dateStyle: "medium" }),
                })}
              </p>
            ) : null}
            <BillingPortalButton org={org} label={t("portal.open")} />
            {paid && !ending ? (
              <section aria-labelledby="end-plan" className="flex flex-col gap-8 pt-8">
                <h3 id="end-plan" className="m-0 text-heading-14 font-semibold">
                  {t("endPlan.title")}
                </h3>
                <p className="m-0 text-text-13 text-text-secondary">{t("endPlan.body")}</p>
                <EndPlanForm org={org} label={t("endPlan.submit")} />
              </section>
            ) : null}
          </section>
        </Card>
      ) : null}
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
      {buying ? (
        // The term is a filter on the plans, so its links read as chips with the current one marked, never as a second
        // primary action beside the plan's Choose button (gate 27).
        <nav aria-label={t("term.label")} className="flex flex-wrap items-center gap-8">
          {(
            [
              ["Monthly", page, t("term.monthly")],
              ["Annual", `${page}?term=annual`, t("term.annual")],
            ] as const
          ).map(([value, href, label]) => (
            <Link
              key={value}
              href={href as Route}
              aria-current={term === value ? "true" : undefined}
              className="inline-flex min-h-target-fine items-center rounded-chip border border-border-subtle px-8 text-text-12 text-text-secondary hover:bg-bg-hover aria-[current=true]:bg-bg-hover aria-[current=true]:font-medium aria-[current=true]:text-text-primary pointer-coarse:min-h-target-coarse"
            >
              {label}
            </Link>
          ))}
        </nav>
      ) : null}
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
                      {plan.adds
                        .filter((f) => planFeatureOffered(f, offering))
                        .map((f) => (
                          <li key={f}>{translate(`shell.plans.features.${f}`)}</li>
                        ))}
                    </ul>
                  </div>
                ) : null}
                <div className="flex flex-col gap-8">
                  {plan.code === current ? (
                    <span className="text-label-13 font-medium text-success-text">
                      {trialing ? t("trialPlan") : tp("current")}
                    </span>
                  ) : null}
                  {plan.selfServe && buying ? (
                    <div>
                      <ButtonLink
                        href={
                          `${page}?review=${plan.code}${term === "Annual" ? "&term=annual" : ""}#renewal-review` as Route
                        }
                      >
                        {term === "Annual"
                          ? t("chooseAnnual", { plan: name(plan.code) })
                          : t("choose", { plan: name(plan.code) })}
                      </ButtonLink>
                    </div>
                  ) : plan.selfServe && plan.code !== current && !billing.open ? (
                    <div>
                      <Button variant="secondary" disabled>
                        {t("choose", { plan: name(plan.code) })}
                      </Button>
                    </div>
                  ) : !plan.selfServe && !plan.free ? (
                    <div>
                      <Button variant="secondary" disabled>
                        {t("contactSales")}
                      </Button>
                    </div>
                  ) : null}
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
      <p className="m-0 text-text-12 text-text-secondary">
        {otherCurrencies.length === 0
          ? t("pricesInUsd")
          : `${t("pricesInUsd")} ${t("pricesInOtherCurrencies", {
              currencies: otherCurrencies.join(", "),
            })}`}
      </p>
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
      <ContributedPanels node="settings.billing-and-plan" ctx={ctx} params={routeParams} />
    </>
  );
}
