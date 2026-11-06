import { getStripeCancellations } from "@xos/data/billing";
import { dayOf } from "@xos/data/org-lifecycle";
import { getTranslations } from "next-intl/server";
import { InlineAlert } from "@/components/ui";
import { stripeHasStopped } from "@/lib/billing/stop-stripe";
import { getFormatters } from "@/lib/platform/format";
import type { OrgContext } from "@/lib/shell/context";
import { getOrgTimeZone } from "@/lib/shell/time-zone";

/**
 * Where the org's Stripe cancels stand, on Billing and Plan and in the Danger zone (ADR 0156). It says only what Stripe has
 * said: accepted once a signed webhook or the worker recorded it, or once Stripe itself says so when asked here. Anything
 * else reads as not confirmed, so nobody is told a charge stopped when it may not have.
 */
export async function StripeCancellationNotice({ ctx }: { ctx: OrgContext }) {
  const cancellations = await getStripeCancellations(ctx.viewer.db, ctx.org.id);
  if (!cancellations.ok || cancellations.data.length === 0) return null;
  const [t, { date }, zone] = await Promise.all([
    getTranslations("shell.settings.billing.stripeCancel"),
    getFormatters(ctx),
    getOrgTimeZone(ctx),
  ]);
  const notices = await Promise.all(
    cancellations.data.map(async (c) => ({
      cancellation: c,
      stopped:
        c.state === "Accepted" || (await stripeHasStopped(c.stripeSubscriptionId, c.mode)),
    })),
  );
  return (
    <div className="flex flex-col gap-8" data-testid="stripe-cancellation">
      {notices.map(({ cancellation: c, stopped }) => {
        if (!stopped) {
          return (
            <InlineAlert key={c.id} tone="warning" title={t("queuedTitle")}>
              {t("queuedBody")}
            </InlineAlert>
          );
        }
        if (c.mode === "Immediately") {
          return (
            <InlineAlert key={c.id} tone="success" title={t("acceptedTitle")}>
              {t("acceptedBody")}
            </InlineAlert>
          );
        }
        return (
          <InlineAlert key={c.id} tone="info" title={t("endingTitle")}>
            {c.endsAt
              ? t("endingBody", { date: date(dayOf(c.endsAt, zone)) })
              : t("endingBodyNoDate")}
          </InlineAlert>
        );
      })}
    </div>
  );
}
