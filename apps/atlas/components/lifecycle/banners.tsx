import {
  dayOf,
  daysOverdue,
  readOnlyOn,
  trialDaysLeft,
  windowLastDay,
  type OrgBannerStatus,
} from "@xos/data/org-lifecycle";
import type { Route } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { OwnershipOfferActions } from "@/components/lifecycle/ownership-offer";
import { OverLimitBanners } from "@/components/plan-limits/banners";
import { Banner } from "@/components/platform/client/banner";
import { getFormatters } from "@/lib/platform/format";
import type { OrgContext } from "@/lib/shell/context";
import { getOrgTimeZone } from "@/lib/shell/time-zone";

/**
 * A79's org banners (Section 12, Section 14.7, Section 16), from the one banner status call
 * (app.org_banner_status): the org waiting for deletion, the dunning state (Owners and Admins from the day a
 * payment fails, everyone once the org is read-only on day 21), the trial countdown for billing owners,
 * white label kept to the end of a paid period after a downgrade, an ownership offer made to the viewer, and what plan
 * limits made read-only (A107, components/plan-limits/banners.tsx). Each names its fix and links to where it is made. Every date and count is on the org's calendar
 * (getOrgTimeZone): a window's last day, never the UTC date of its end.
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
  const [{ date }, zone] = await Promise.all([getFormatters(ctx), getOrgTimeZone(ctx)]);
  const slug = ctx.org.slug;
  const billingHref = `/${slug}/settings/billing-and-plan` as Route;
  const dangerHref = `/${slug}/settings/danger-zone` as Route;
  const owner = ctx.capabilities.has("org.billing.manage");
  const banners = [];

  if (status.readOnlyReason === "deletion" && status.recoverUntil) {
    banners.push(
      <Banner key="deletion" tone="danger" icon="Trash2">
        <span data-testid="deletion-banner">
          {t("banners.deletion", { date: date(windowLastDay(status.recoverUntil, zone)) })}{" "}
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
                date: date(dayOf(readOnlyOn(status.pastDueSince), zone)),
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
            days: trialDaysLeft(status.trialEndsAt, zone),
            org: ctx.org.name,
            date: date(windowLastDay(status.trialEndsAt, zone)),
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
          {t("banners.whiteLabel", { date: date(windowLastDay(status.whiteLabelUntil, zone)) })}{" "}
          <Link href={billingHref} className={linkClass}>
            {t("banners.whiteLabelAction")}
          </Link>
        </span>
      </Banner>,
    );
  }

  if (status.ownershipOffer) {
    const refusals = Object.fromEntries([
      ...[...OFFER_REFUSALS].map((rule) => [rule, t(`refusals.${rule}`)]),
      ["other", t("refusals.other")],
    ]);
    banners.push(
      <Banner key="ownership" tone="info" icon="Handshake">
        <span data-testid="ownership-offer-banner" className="flex flex-col gap-8">
          <span>
            {t("banners.ownership", {
              name: status.ownershipOffer.offeredBy,
              org: ctx.org.name,
              date: date(windowLastDay(status.ownershipOffer.expiresAt, zone)),
            })}
          </span>
          <OwnershipOfferActions
            org={slug}
            transfer={status.ownershipOffer.transferId}
            acceptLabel={t("banners.ownershipAccept")}
            declineLabel={t("banners.ownershipDecline")}
            refusals={refusals}
          />
        </span>
      </Banner>,
    );
  }

  banners.push(...(await OverLimitBanners({ ctx, status })));

  return banners.length > 0 ? <>{banners}</> : null;
}
