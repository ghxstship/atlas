import { addCalendarDays, startOfDayIn, todayIn } from "@xos/data/calendar";
import { listMyRecordsBetween } from "@xos/data/home";
import { listProjects } from "@xos/data/projects";
import { getTranslations } from "next-intl/server";
import { TodayView } from "@/components/home/home-views";
import { PageHeader } from "@/components/projects/ui";
import { requireNode } from "@/lib/shell/require-node";
import { pickView } from "@/lib/home/views";
import { must } from "@/lib/projects/loaders";
import { nodeHref } from "@/lib/shell/sitemap";
import { getOrgTimeZone } from "@/lib/shell/time-zone";

/** Home > Today (Section 4.5.5): what is due or running for the viewer today. */
export default async function Page({ params, searchParams }: PageProps<"/[org]/home/today">) {
  const routeParams = await params;
  const ctx = await requireNode("home.today", routeParams);
  const t = await getTranslations("home.today");
  const db = ctx.viewer.db;
  // Today on the org's calendar, from its local midnight to the next (A71). Before, the window began at
  // the server's midnight and the date was UTC's, so the evening in New York showed tomorrow.
  const zone = await getOrgTimeZone(ctx);
  const today = todayIn(zone);
  const start = new Date(startOfDayIn(today, zone));
  const end = new Date(startOfDayIn(addCalendarDays(today, 1), zone));
  const personId = ctx.viewer.person?.id;
  const [records, projects] = await Promise.all([
    personId
      ? listMyRecordsBetween(db, { orgId: ctx.org.id, personId, from: start, to: end })
      : Promise.resolve({ ok: true as const, data: [] }),
    listProjects(db, ctx.org.id),
  ]);
  const edges = must(projects, "projects").flatMap((p) => [
    ...(p.startsOn === today ? [{ key: p.key, name: p.name, edge: "starts" as const }] : []),
    ...(p.endsOn === today ? [{ key: p.key, name: p.name, edge: "ends" as const }] : []),
  ]);
  const { views, view } = pickView("home.today", await searchParams);
  return (
    <>
      <PageHeader title={t("title")} />
      <TodayView
        org={ctx.org.slug}
        records={must(records, "today's records")}
        projects={edges}
        views={views}
        view={view}
        projectsHref={nodeHref("projects", routeParams) ?? ""}
      />
    </>
  );
}
