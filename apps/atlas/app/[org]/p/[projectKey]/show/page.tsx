import { notFound } from "next/navigation";
import { RunsPage } from "@/components/show/show-pages";
import { requireNode } from "@/components/shell/sitemap-page";
import { getProjectContextFor } from "@/lib/projects/context";

/** Project Show (Section 4.5.4): the project's running orders, cues and live cue calls. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/p/[projectKey]/show">) {
  const routeParams = await params;
  await requireNode("project.show", routeParams);
  const ctx = await getProjectContextFor(routeParams);
  if (!ctx) notFound();
  const { id, key, name, timeZone } = ctx.project;
  return (
    <RunsPage
      ctx={ctx.org}
      node="project.show"
      search={await searchParams}
      project={{ id, key, name, timeZone }}
    />
  );
}
