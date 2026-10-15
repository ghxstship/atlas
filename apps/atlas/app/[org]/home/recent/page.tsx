import { listRecentRecords } from "@xos/data/home";
import { listProjects } from "@xos/data/projects";
import { getTranslations } from "next-intl/server";
import { RecentView } from "@/components/home/home-views";
import { PageHeader } from "@/components/projects/ui";
import { requireNode } from "@/components/shell/sitemap-page";
import { pickView } from "@/lib/home/views";
import { must } from "@/lib/projects/loaders";
import { nodeHref } from "@/lib/shell/sitemap";

/** Home > Recent (Section 4.5.5): the viewer's recently changed records and projects. */
export default async function Page({ params, searchParams }: PageProps<"/[org]/home/recent">) {
  const routeParams = await params;
  const ctx = await requireNode("home.recent", routeParams);
  const t = await getTranslations("home.recent");
  const db = ctx.viewer.db;
  const personId = ctx.viewer.person?.id;
  const [records, projects] = await Promise.all([
    personId
      ? listRecentRecords(db, { orgId: ctx.org.id, personId })
      : Promise.resolve({ ok: true as const, data: [] }),
    listProjects(db, ctx.org.id),
  ]);
  const recentProjects = [...must(projects, "projects")]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, 5);
  const { views, view } = pickView("home.recent", await searchParams);
  return (
    <>
      <PageHeader title={t("title")} />
      <RecentView
        org={ctx.org.slug}
        records={must(records, "recent records")}
        projects={recentProjects}
        views={views}
        view={view}
        projectsHref={nodeHref("projects", routeParams) ?? ""}
      />
    </>
  );
}
