import { getSubscription } from "@xos/data";
import { getFormatter, getTranslations } from "next-intl/server";
import { SectionHeader } from "@/components/settings/section-header";
import { requireNode } from "@/components/shell/sitemap-page";
import { Button, Card, InlineAlert } from "@/components/ui";
import { PLANS } from "@/lib/plans.generated";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Billing and Plan (Section 16, Section 4.5.6 item 36; Owner only). Shows the current plan and the
 * plans of packages/schemas/plans.yaml with their limits and features, up to the plan choice.
 * Subscribing runs through Stripe (A18), so the choose buttons stay disabled until billing lands.
 */
export default async function BillingSettingsPage({
  params,
}: PageProps<"/[org]/settings/billing-and-plan">) {
  const ctx = await requireNode("settings.billing-and-plan", await params);
  const [subscription, t, tp, translate, format] = await Promise.all([
    getSubscription(ctx.viewer.db, ctx.org.id),
    getTranslations("shell.settings.billing"),
    getTranslations("shell.plans"),
    getTranslate(),
    getFormatter(),
  ]);
  if (!subscription.ok) {
    throw new Error(`Cannot read the subscription: ${JSON.stringify(subscription.error)}`);
  }
  const current = subscription.data.planCode;
  const name = (code: string) => translate(`shell.plans.${code}.name`);
  return (
    <>
      <SectionHeader node="settings.billing-and-plan" />
      <p className="m-0 text-text-14">{t("current", { org: ctx.org.name, plan: name(current) })}</p>
      <InlineAlert tone="info">{t("notAvailable")}</InlineAlert>
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
                      : plan.usdMonthlyMinor === null
                        ? tp("unpriced")
                        : t("perMonth", {
                            price: format.number(plan.usdMonthlyMinor / 100, {
                              style: "currency",
                              currency: "USD",
                            }),
                          })}
                  </span>
                </div>
                <p className="m-0 text-text-13 text-text-secondary">
                  {translate(`shell.plans.${plan.code}.audience`)}
                </p>
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
                  ) : (
                    <Button disabled>{t("choose", { plan: name(plan.code) })}</Button>
                  )}
                </div>
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}
