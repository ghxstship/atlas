import { notFound } from "next/navigation";
import { requireNode } from "@/lib/shell/require-node";
import { RecordsPage } from "@/components/work/records-page";
import { getProjectContextFor } from "@/lib/projects/context";

/** Project Schedule (Section 4.5.4): the project's dated records on the timeline with the latest baseline, the calendar and the list. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/p/[projectKey]/schedule">) {
  const routeParams = await params;
  await requireNode("project.schedule", routeParams);
  const ctx = await getProjectContextFor(routeParams);
  if (!ctx) notFound();
  const { id, key, name, timeZone } = ctx.project;
  return (
    <RecordsPage
      ctx={ctx.org}
      node="project.schedule"
      search={await searchParams}
      project={{ id, key, name, timeZone }}
      emptyKey="projectSchedule"
      datedOnly
    />
  );
}
