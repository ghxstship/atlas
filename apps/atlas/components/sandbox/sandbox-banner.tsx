import { sandboxEnds } from "@xos/data/sandbox";
import { getLocale, getTranslations } from "next-intl/server";
import { Banner } from "@/components/platform/client/banner";
import type { OrgContext } from "@/lib/shell/context";
import { getOrgTimeZone } from "@/lib/shell/time-zone";

/**
 * Says plainly, above every page of a sandbox org, that it is the person's private sandbox, that nothing in it is
 * billed, emailed or texted, and the instant it ends, shown on the sandbox's calendar (Section 11.7, A96, 1530).
 * Renders nothing in any other org.
 */
export async function SandboxBanner({ ctx }: { ctx: OrgContext }) {
  const ends = await sandboxEnds(ctx.viewer.db, ctx.org.id);
  if (!ends.ok || ends.data === null) return null;
  const [t, locale, zone] = await Promise.all([
    getTranslations("firstRun.sandbox"),
    getLocale(),
    getOrgTimeZone(ctx),
  ]);
  const when = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: zone,
  }).format(new Date(ends.data));
  return (
    <div className="mb-16" data-testid="sandbox-banner">
      <Banner tone="info" icon="Sparkles">
        {t("banner", { when })}
      </Banner>
    </div>
  );
}
