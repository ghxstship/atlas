import { dayOf, getOrgBannerStatus, readOnlyOn, windowLastDay } from "@xos/data/org-lifecycle";
import { getTranslations } from "next-intl/server";
import { BillingPortalButton, CheckoutButton } from "@/components/settings/billing-forms";
import { Button, Card, InlineAlert } from "@/components/ui";
import { getFormatters } from "@/lib/platform/format";
import type { OrgContext } from "@/lib/shell/context";
import { getOrgTimeZone } from "@/lib/shell/time-zone";

/**
 * The trial and dunning state at the top of Billing and Plan (A79; Section 14.7 and Section 16), where the
 * org banners send the Owner to fix billing. Once billing is open (owner decision 21 of 2026-10-23), adding a
 * card opens Stripe Checkout for the trial's plan, carrying the rest of the trial so nothing is charged
 * before it ends, and updating the payment method opens the Stripe customer portal. Until then the button
 * stays disabled and the copy says how to get it done. Dates are days on the org's calendar.
 */
export async function BillingLifecycleNotice({
  ctx,
  billing,
}: {
  ctx: OrgContext;
  /** Whether billing is open, and whether the org has a Stripe customer whose portal can open. */
  billing: { readonly open: boolean; readonly portal: boolean };
}) {
  const status = await getOrgBannerStatus(ctx.viewer.db, ctx.org.id);
  if (!status.ok) return null;
  const s = status.data;
  if (!s.trialEndsAt && !s.billingState) return null;
  const t = (await getTranslations("orgLifecycle")) as unknown as (
    key: string,
    values?: Record<string, string | number>,
  ) => string;
  const [{ date }, zone] = await Promise.all([getFormatters(ctx), getOrgTimeZone(ctx)]);
  const readOnly = s.billingState === "read_only";
  const action = s.billingState ? t("billing.updatePayment") : t("banners.trialAction");
  const button =
    s.billingState && billing.open && billing.portal ? (
      <BillingPortalButton org={ctx.org.slug} label={action} variant="primary" />
    ) : !s.billingState && billing.open && s.trialPlan ? (
      <CheckoutButton
        org={ctx.org.slug}
        plan={s.trialPlan}
        interval="Monthly"
        label={action}
        variant="primary"
      />
    ) : null;
  return (
    <Card>
      <section
        aria-labelledby="billing-lifecycle"
        className="flex flex-col gap-8"
        data-testid="billing-lifecycle"
      >
        <h2 id="billing-lifecycle" className="m-0 text-heading-16 font-semibold">
          {s.billingState
            ? t(readOnly ? "billing.readOnlyTitle" : "billing.pastDueTitle")
            : t("billing.trialTitle")}
        </h2>
        <p className="m-0 text-text-14">
          {s.billingState && s.pastDueSince
            ? t(readOnly ? "billing.readOnlyBody" : "billing.pastDueBody", {
                since: date(dayOf(s.pastDueSince, zone)),
                date: date(dayOf(readOnlyOn(s.pastDueSince), zone)),
              })
            : t("billing.trialBody", {
                org: ctx.org.name,
                date: s.trialEndsAt ? date(windowLastDay(s.trialEndsAt, zone)) : "",
              })}
        </p>
        {button ?? (
          <>
            <div>
              <Button variant="primary" disabled>
                {action}
              </Button>
            </div>
            <InlineAlert tone="info">{t("billing.notConnected")}</InlineAlert>
          </>
        )}
      </section>
    </Card>
  );
}
