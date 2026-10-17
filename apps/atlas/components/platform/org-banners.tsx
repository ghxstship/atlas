import { daysUntil, getCancellation } from "@xos/data/lifecycle";
import { getTranslations } from "next-intl/server";
import type { OrgContext } from "@/lib/shell/context";
import { getFormatters } from "@/lib/platform/format";
import { endViewAsAction } from "@/lib/platform/settings-actions";
import { Banner } from "@/components/platform/ui";

/**
 * Org-wide banners above every page (A36): the read-only banner of a canceled org during its 30-day
 * window (Section 14.7), and the View as role banner with its exit (Section 8.4).
 */
export async function OrgBanners({ ctx }: { ctx: OrgContext }) {
  const cancellation = await getCancellation(ctx.viewer.db, ctx.org.id);
  if (!cancellation.ok)
    throw new Error(`Cannot read the org's cancellation: ${JSON.stringify(cancellation.error)}`);
  if (!cancellation.data && !ctx.preview) return null;
  const { t, date } = await getFormatters(ctx);
  const shell = (await getTranslations("shell")) as unknown as (k: string) => string;
  return (
    <div className="mb-16 flex flex-col gap-8">
      {cancellation.data ? (
        <Banner tone="warning" icon="Lock">
          <span data-testid="read-only-banner">
            {t("lifecycle.banner", {
              days: daysUntil(cancellation.data.readOnlyUntil),
              until: date(cancellation.data.readOnlyUntil),
            })}
          </span>
        </Banner>
      ) : null}
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
