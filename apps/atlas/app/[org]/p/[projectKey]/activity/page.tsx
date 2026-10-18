import { notFound } from "next/navigation";
import { ActivityPage } from "@/components/activity/activity-page";
import { requireNode } from "@/lib/shell/require-node";
import { getProjectContextFor } from "@/lib/projects/context";

/** Project Activity (Section 4.5.4): the project's activity feed. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/p/[projectKey]/activity">) {
  const routeParams = await params;
  await requireNode("project.activity", routeParams);
  const ctx = await getProjectContextFor(routeParams);
  if (!ctx) notFound();
  return (
    <ActivityPage
      ctx={ctx.org}
      node="project.activity"
      params={routeParams}
      searchParams={await searchParams}
      project={{ id: ctx.project.id, key: ctx.project.key }}
    />
  );
}
