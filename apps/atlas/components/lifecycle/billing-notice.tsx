import { dayOf, getOrgBannerStatus, readOnlyOn, windowLastDay } from "@xos/data/org-lifecycle";
import type { Route } from "next";
import { getTranslations } from "next-intl/server";
import { BillingPortalButton } from "@/components/settings/billing-forms";
import { Button, ButtonLink, Card, InlineAlert } from "@/components/ui";
import { getFormatters } from "@/lib/platform/format";
import type { OrgContext } from "@/lib/shell/context";
import { getOrgTimeZone } from "@/lib/shell/time-zone";

/**
 * The trial and dunning state at the top of Billing and Plan (A79; Section 14.7 and Section 16), where the
 * org banners send the Owner to fix billing. Once billing is open (ADR 0033 decision 59), adding a
 * card shows the renewal terms of the trial's plan (ADR 0161), then opens Stripe Checkout, carrying the rest of the
 * trial so nothing is charged before it ends, and updating the payment method opens the Stripe customer portal. Until
 * then the button stays disabled and the copy says how to get it done; while a paid checkout waits for its
 * subscription to sync, it stays disabled and the page says Stripe is confirming. Once billing is open, a button the
 * org cannot use stays disabled: the page says why Checkout does not open (a partner billing the org, a sandbox, an
 * org being deleted), and an overdue org without a Stripe customer to open the portal on is sent to support. Dates are
 * days on the org's calendar.
 */
export async function BillingLifecycleNotice({
  ctx,
  billing,
}: {
  ctx: OrgContext;
  /**
   * Whether billing is open, whether the org has a Stripe customer whose portal can open, whether a paid checkout
   * still waits for its subscription to sync, whether the renewal terms are already on the page, so the screen keeps
   * its one primary action, and whether Checkout opens for the org (no rule of app.billing_account refuses it).
   */
  billing: {
    readonly open: boolean;
    readonly portal: boolean;
    readonly awaiting: boolean;
    readonly reviewing?: boolean;
    readonly checkout: boolean;
  };
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
    ) : !s.billingState && billing.reviewing ? (
      <></>
    ) : !s.billingState && billing.open && !billing.awaiting && billing.checkout && s.trialPlan ? (
      <div>
        <ButtonLink
          variant="primary"
          href={
            `/${ctx.org.slug}/settings/billing-and-plan?review=${s.trialPlan}#renewal-review` as Route
          }
        >
          {action}
        </ButtonLink>
      </div>
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
            {!billing.open ? (
              <InlineAlert tone="info">{t("billing.notConnected")}</InlineAlert>
            ) : billing.awaiting ? null : s.billingState ? (
              <InlineAlert tone="info">{t("billing.contactSupport")}</InlineAlert>
            ) : null}
          </>
        )}
      </section>
    </Card>
  );
}
