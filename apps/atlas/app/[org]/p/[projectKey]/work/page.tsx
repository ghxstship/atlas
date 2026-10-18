import { notFound } from "next/navigation";
import { requireNode } from "@/lib/shell/require-node";
import { RecordsPage } from "@/components/work/records-page";
import { getProjectContextFor } from "@/lib/projects/context";

/** Project Work (Section 4.5.4): the project's records of every kind as a list, table, board, calendar or timeline. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/p/[projectKey]/work">) {
  const routeParams = await params;
  await requireNode("project.work", routeParams);
  const ctx = await getProjectContextFor(routeParams);
  if (!ctx) notFound();
  const { id, key, name, timeZone } = ctx.project;
  return (
    <RecordsPage
      ctx={ctx.org}
      node="project.work"
      search={await searchParams}
      project={{ id, key, name, timeZone }}
      emptyKey="projectWork"
    />
  );
}
