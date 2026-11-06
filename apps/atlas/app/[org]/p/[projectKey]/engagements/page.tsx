import { notFound } from "next/navigation";
import { EngagementsView } from "@/components/opportunities/engagements-view";
import { setupPage, type SearchParams } from "@/lib/opportunities/page";
import { getProjectContextFor } from "@/lib/projects/context";
import { nodeHref } from "@/lib/shell/sitemap";

/**
 * The project Engagements tab (Section 4.5.4, twin of Opportunities > Engagements): the external engagements of this
 * project only. A project the viewer may not read answers 404 (invariant 2).
 */
export default async function ProjectEngagementsPage({
  params,
  searchParams,
}: PageProps<"/[org]/p/[projectKey]/engagements">) {
  const routeParams = await params;
  const project = await getProjectContextFor(routeParams);
  if (!project) notFound();
  const page = await setupPage(
    "project.engagements",
    routeParams,
    (await searchParams) as SearchParams,
    project.org,
  );
  return (
    <EngagementsView
      page={page}
      projectId={project.project.id}
      emptyHref={nodeHref("opportunities.postings", routeParams) ?? page.base}
    />
  );
}
