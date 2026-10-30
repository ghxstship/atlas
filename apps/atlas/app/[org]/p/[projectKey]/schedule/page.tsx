import { getProjectAnchor } from "@xos/data/anchor";
import { notFound } from "next/navigation";
import { requireNode } from "@/lib/shell/require-node";
import { RecordsPage } from "@/components/work/records-page";
import { AnchorBar } from "@/components/schedule/anchor-bar";
import { getProjectContextFor } from "@/lib/projects/context";

/**
 * Project Schedule (Section 4.5.4): the project's dated records on the timeline with the latest baseline, the
 * calendar and the list, under the project's anchor day (B4, G-44): the timeline draws it as a gate and counts each
 * record's offset from it, and Move anchor moves the plan with it.
 */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/p/[projectKey]/schedule">) {
  const routeParams = await params;
  await requireNode("project.schedule", routeParams);
  const ctx = await getProjectContextFor(routeParams);
  if (!ctx) notFound();
  const { id, key, name, timeZone } = ctx.project;
  const anchor = await getProjectAnchor(ctx.org.viewer.db, id);
  const caps = ctx.capabilities;
  return (
    <div className="flex flex-col gap-12">
      <AnchorBar
        org={ctx.org.org.slug}
        project={{ id, key }}
        anchorOn={anchor.ok ? anchor.data : null}
        canSet={caps.has("projects.project.write")}
        canMove={caps.has("projects.project.write") && caps.has("schedule.timeline.write")}
      />
      <RecordsPage
        ctx={ctx.org}
        node="project.schedule"
        search={await searchParams}
        project={{ id, key, name, timeZone }}
        emptyKey="projectSchedule"
        datedOnly
      />
    </div>
  );
}
