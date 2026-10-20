import { daysOverdue, readOnlyOn, type OrgBannerStatus } from "@xos/data/org-lifecycle";
import { daysUntil } from "@xos/data/lifecycle";
import type { Route } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { Banner } from "@/components/platform/client/banner";
import { acceptOwnershipFormAction, declineOwnershipFormAction } from "@/lib/lifecycle/actions";
import { OWNERSHIP_OUTCOME_COOKIE, ownershipRefusal } from "@/lib/lifecycle/outcome";
import { getFormatters } from "@/lib/platform/format";
import type { OrgContext } from "@/lib/shell/context";

/**
 * A79's org banners (Section 12, Section 14.7, Section 16), from the one banner status call
 * (app.org_banner_status): the org waiting for deletion, the dunning state (Owners and Admins from the day a
 * payment fails, everyone once the org is read-only on day 21), the trial countdown for billing owners,
 * white label kept to the end of a paid period after a downgrade, and an ownership offer made to the viewer.
 * Each names its fix and links to where it is made.
 */

const linkClass = "font-medium text-accent-text underline";
/** Refusals an answer to an ownership offer can meet, each with its own copy. */
const OFFER_REFUSALS = new Set([
  "step_up_required",
  "step_up_session_only",
  "ownership_transfer_closed",
  "ownership_transfer_expired",
  "ownership_transfer_stale",
  "ownership_transfer_not_member",
  "seat_limit_reached",
  "seat_limit_upgrade",
  "org_read_only",
]);
const buttonClass =
  "inline-flex h-control-sm items-center rounded-control px-12 text-label-13 font-medium focus-visible:outline-2";

export async function LifecycleBanners({
  ctx,
  status,
}: {
  ctx: OrgContext;
  status: OrgBannerStatus;
}) {
  const t = (await getTranslations("orgLifecycle")) as unknown as (
    key: string,
    values?: Record<string, string | number>,
  ) => string;
  const { date } = await getFormatters(ctx);
  const slug = ctx.org.slug;
  const billingHref = `/${slug}/settings/billing-and-plan` as Route;
  const dangerHref = `/${slug}/settings/danger-zone` as Route;
  const owner = ctx.capabilities.has("org.billing.manage");
  const banners = [];

  if (status.readOnlyReason === "deletion" && status.recoverUntil) {
    banners.push(
      <Banner key="deletion" tone="danger" icon="Trash2">
        <span data-testid="deletion-banner">
          {t("banners.deletion", { date: date(status.recoverUntil) })}{" "}
          {ctx.capabilities.has("org.organization.delete") ? (
            <Link href={dangerHref} className={linkClass}>
              {t("banners.deletionAction")}
            </Link>
          ) : null}
        </span>
      </Banner>,
    );
  }

  if (status.billingState && status.pastDueSince) {
    const readOnly = status.billingState === "read_only";
    banners.push(
      <Banner key="dunning" tone={readOnly ? "danger" : "warning"} icon="Wallet">
        <span data-testid="dunning-banner">
          {readOnly
            ? t("banners.readOnly")
            : t("banners.pastDue", {
                days: daysOverdue(status.pastDueSince),
                date: date(readOnlyOn(status.pastDueSince)),
              })}{" "}
          {owner ? (
            <Link href={billingHref} className={linkClass}>
              {t("banners.billingAction")}
            </Link>
          ) : (
            t("banners.askOwner")
          )}
        </span>
      </Banner>,
    );
  }

  if (status.trialPlan && status.trialEndsAt && ctx.capabilities.has("org.billing.read")) {
    banners.push(
      <Banner key="trial" tone="info" icon="Sparkles">
        <span data-testid="trial-banner">
          {t("banners.trial", {
            days: daysUntil(status.trialEndsAt),
            org: ctx.org.name,
            date: date(status.trialEndsAt),
          })}{" "}
          <Link href={billingHref} className={linkClass}>
            {t("banners.trialAction")}
          </Link>
        </span>
      </Banner>,
    );
  }

  if (status.whiteLabelUntil) {
    banners.push(
      <Banner key="white-label" tone="info" icon="Palette">
        <span data-testid="white-label-banner">
          {t("banners.whiteLabel", { date: date(status.whiteLabelUntil) })}{" "}
          <Link href={billingHref} className={linkClass}>
            {t("banners.whiteLabelAction")}
          </Link>
        </span>
      </Banner>,
    );
  }

  if (status.ownershipOffer) {
    const refusal = ownershipRefusal(
      (await cookies()).get(OWNERSHIP_OUTCOME_COOKIE)?.value,
      status.ownershipOffer.transferId,
    );
    banners.push(
      <Banner key="ownership" tone="info" icon="Handshake">
        <span data-testid="ownership-offer-banner" className="flex flex-col gap-8">
          <span>
            {t("banners.ownership", {
              name: status.ownershipOffer.offeredBy,
              org: ctx.org.name,
              date: date(status.ownershipOffer.expiresAt),
            })}
          </span>
          <span className="flex flex-wrap items-center gap-8">
            <form action={acceptOwnershipFormAction}>
              <input type="hidden" name="org" value={slug} />
              <input type="hidden" name="transfer" value={status.ownershipOffer.transferId} />
              <button
                type="submit"
                className={`${buttonClass} bg-accent-default text-accent-text-on`}
              >
                {t("banners.ownershipAccept")}
              </button>
            </form>
            <form action={declineOwnershipFormAction}>
              <input type="hidden" name="org" value={slug} />
              <input type="hidden" name="transfer" value={status.ownershipOffer.transferId} />
              <button
                type="submit"
                className={`${buttonClass} border border-border-control text-text-primary`}
              >
                {t("banners.ownershipDecline")}
              </button>
            </form>
          </span>
          {refusal ? (
            <span role="alert" className="text-text-13">
              {t(OFFER_REFUSALS.has(refusal) ? `refusals.${refusal}` : "refusals.other")}{" "}
              {refusal === "step_up_required" ? (
                <Link href={`/${slug}/me/security` as Route} className={linkClass}>
                  {t("stepUp.action")}
                </Link>
              ) : null}
            </span>
          ) : null}
        </span>
      </Banner>,
    );
  }

  return banners.length > 0 ? <>{banners}</> : null;
}
