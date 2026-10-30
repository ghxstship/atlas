import { addDays } from "@xos/ui/quick-add";
import { loadWorkload } from "@xos/data/workload";
import { todayIn } from "@xos/data/calendar";
import { getNode } from "@xos/ia";
import { loadRecordMeta, must, nodeViews, param, type SearchParams } from "@/components/work/load";
import type { OrgContext } from "@/lib/shell/context";
import { sitemap } from "@/lib/shell/sitemap";
import { getOrgTimeZone } from "@/lib/shell/time-zone";
import { getTranslate } from "@/lib/shell/translate";
import { WorkloadCollection } from "./workload";

/** The Monday of the week a date falls in, as YYYY-MM-DD. */
export function weekStart(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7;
  return addDays(day, -offset);
}

/**
 * Schedule > Workload (B4, G-45): a week of hours per person per day as a heatmap or a table. app.workload computes
 * them as the viewer, so row level security decides which projects count, and nothing is stored; the org's
 * scheduling.workload_day_hours marks the days over.
 */
export async function WorkloadPage({ ctx, search }: { ctx: OrgContext; search: SearchParams }) {
  const t = await getTranslate();
  const node = "schedule.workload";
  const { views, defaultView } = nodeViews(node);
  const requested = param(search, "view");
  const view = requested && views.includes(requested) ? requested : defaultView;
  const meta = await loadRecordMeta(ctx);
  const projectKey = param(search, "project") ?? "";
  const project = meta.projects.find((p) => p.key === projectKey);
  const today = todayIn(project?.timeZone ?? (await getOrgTimeZone(ctx)));
  const weekParam = param(search, "week");
  const from = weekStart(weekParam && /^\d{4}-\d{2}-\d{2}$/.test(weekParam) ? weekParam : today);
  const to = addDays(from, 6);
  const workload = must(
    await loadWorkload(ctx.viewer.db, {
      orgId: ctx.org.id,
      from,
      to,
      projectId: project?.id ?? null,
    }),
    "workload",
  );
  return (
    <WorkloadCollection
      org={ctx.org.slug}
      title={t(getNode(sitemap, node).node.label)}
      views={views}
      view={view}
      from={from}
      to={to}
      projectKey={project ? projectKey : ""}
      projects={meta.projects}
      workload={workload}
      cell={param(search, "cell") ?? null}
    />
  );
}
