import { getTranslations } from "next-intl/server";
import { AlertsView } from "@/components/home/home-views";
import { PageHeader } from "@/components/projects/ui";
import { requireNode } from "@/lib/shell/require-node";
import { loadAlerts } from "@/lib/home/data";
import { pickView } from "@/lib/home/views";
import { nodeHref } from "@/lib/shell/sitemap";
import { getOrgTimeZone } from "@/lib/shell/time-zone";

/** Home > Alerts (Section 4.5.5): blocked work, overdue records and gate gaps near the show. */
export default async function Page({ params, searchParams }: PageProps<"/[org]/home/alerts">) {
  const routeParams = await params;
  const ctx = await requireNode("home.alerts", routeParams);
  const t = await getTranslations("home.alerts");
  const alerts = await loadAlerts(ctx);
  const { views, view } = pickView("home.alerts", await searchParams);
  const timeZone = await getOrgTimeZone(ctx);
  return (
    <>
      <PageHeader title={t("title")} count={alerts.length} />
      <AlertsView
        org={ctx.org.slug}
        alerts={alerts}
        views={views}
        view={view}
        projectsHref={nodeHref("projects", routeParams) ?? ""}
        timeZone={timeZone}
      />
    </>
  );
}
