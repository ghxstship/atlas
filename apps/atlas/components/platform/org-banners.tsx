import { daysUntil } from "@xos/data/lifecycle";
import { getOrgBannerStatus } from "@xos/data/org-lifecycle";
import { getTranslations } from "next-intl/server";
import type { OrgContext } from "@/lib/shell/context";
import { getFormatters } from "@/lib/platform/format";
import { endViewAsAction } from "@/lib/platform/settings-actions";
import { Banner } from "@/components/platform/client/banner";
import { LifecycleBanners } from "@/components/lifecycle/banners";

/**
 * Org-wide banners above every page (A36, A79): the read-only banner of a canceled org during its 30-day
 * window (Section 14.7), A79's lifecycle banners (deletion, dunning, the trial countdown, white label kept
 * after a downgrade, an ownership offer and B16's subscription pause, whose read-only reason 'paused' the lifecycle
 * banner names; components/lifecycle/banners.tsx), and the View as role banner
 * with its exit (Section 8.4). One call, app.org_banner_status, feeds every lifecycle banner.
 */
export async function OrgBanners({ ctx }: { ctx: OrgContext }) {
  const status = await getOrgBannerStatus(ctx.viewer.db, ctx.org.id);
  if (!status.ok && process.env["XOS_MEASURE"] === "1") return null; // MEASURE-ONLY
  if (!status.ok)
    throw new Error(`Cannot read the org's banner status: ${JSON.stringify(status.error)}`);
  const canceled = status.data.readOnlyReason === "canceled" && status.data.readOnlyUntil !== null;
  const lifecycle = await LifecycleBanners({ ctx, status: status.data });
  if (!canceled && !lifecycle && !ctx.preview) return null;
  const { t, date } = await getFormatters(ctx);
  const shell = (await getTranslations("shell")) as unknown as (k: string) => string;
  return (
    <div className="mb-16 flex flex-col gap-8">
      {canceled && status.data.readOnlyUntil ? (
        <Banner tone="warning" icon="Lock">
          <span data-testid="read-only-banner">
            {t("lifecycle.banner", {
              days: daysUntil(status.data.readOnlyUntil),
              until: date(status.data.readOnlyUntil),
            })}
          </span>
        </Banner>
      ) : null}
      {lifecycle}
      {ctx.preview ? (
        <Banner tone="info" icon="Eye">
          <form action={endViewAsAction} className="flex flex-wrap items-center gap-8">
            <span>
              {t("access.viewAs.banner", {
                role: ctx.preview.system
                  ? shell(`roles.${ctx.preview.roleCode}`)
                  : (ctx.preview.roleName ?? ctx.preview.roleCode),
              })}
            </span>
            <input type="hidden" name="org" value={ctx.org.slug} />
            <button
              type="submit"
              className="rounded-control px-8 text-text-13 font-medium text-accent-text underline"
            >
              {t("access.viewAs.exit")}
            </button>
          </form>
        </Banner>
      ) : null}
    </div>
  );
}
