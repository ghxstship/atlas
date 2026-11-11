import { getTranslations } from "next-intl/server";
import Link from "next/link";
import type { Route } from "next";
import { Banner } from "@/components/platform/client/banner";
import { loadActiveCrisisAlerts } from "@/lib/home/crisis";
import type { OrgContext } from "@/lib/shell/context";

/** At most this many alerts show as banners; the rest are counted in the last line. */
const SHOWN = 3;

/**
 * The crisis banner above every page of the org while a crisis alert is in force for the viewer (crawl 4.9): the
 * code, the project and the message, with a link to the emergency codes page, until the all-clear. Alerts come from
 * listActiveCrisisAlerts (read once per request with Home's): the rows the viewer may read and the crisis_alert.issued
 * notifications that told them. It never takes a page down: a failed read shows no banner, and the Inbox and Home
 * still carry the alert.
 */
export async function CrisisBanner({ ctx }: { ctx: OrgContext }) {
  const alerts = await loadActiveCrisisAlerts(ctx);
  if (!alerts.ok || alerts.data.length === 0) return null;
  const t = await getTranslations("shell.crisisBanner");
  const base = `/${ctx.org.slug}/safety/emergency-codes`;
  const more = alerts.data.length - SHOWN;
  return (
    <div className="mb-16 flex flex-col gap-8" data-testid="crisis-banner">
      {alerts.data.slice(0, SHOWN).map((a) => {
        const project = a.projectKey ?? a.projectName;
        const href = (
          a.projectKey ? `${base}?project=${encodeURIComponent(a.projectKey)}` : base
        ) as Route;
        return (
          <Banner key={a.id} tone="danger">
            <span className="flex flex-wrap items-baseline gap-x-8">
              <strong className="font-semibold">
                {project
                  ? t("titleOnProject", { title: a.title || t("untitled"), project })
                  : t("title", { title: a.title || t("untitled") })}
              </strong>
              {a.message ? <span>{a.message}</span> : null}
              <Link href={href} className="font-medium text-accent-text underline">
                {t("open")}
              </Link>
            </span>
          </Banner>
        );
      })}
      {more > 0 ? (
        <Banner tone="danger">
          <Link href={base as Route} className="font-medium text-accent-text underline">
            {t("more", { count: more })}
          </Link>
        </Banner>
      ) : null}
    </div>
  );
}
