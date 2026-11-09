import { listDayTemplates } from "@xos/data/day-templates";
import { listCanonTeams, listProjectDays, listShowNodes } from "@xos/data/schedule-days";
import { listRunsOfShow } from "@xos/data/show";
import { listRecords } from "@xos/data/work";
import { listVenues } from "@xos/data/projects";
import { todayIn } from "@xos/data/calendar";
import { getNode } from "@xos/ia";
import {
  capabilitySet,
  loadRecordMeta,
  must,
  nodeViews,
  param,
  type SearchParams,
} from "@/components/work/load";
import type { OrgContext } from "@/lib/shell/context";
import { sitemap } from "@/lib/shell/sitemap";
import { getOrgTimeZone } from "@/lib/shell/time-zone";
import { getTranslate } from "@/lib/shell/translate";
import { DaysCollection, type DayGridSource } from "./days";

/** `<project key>:<YYYY-MM-DD>`, the day a dialog or the grid is open on. */
function dayRef(value: string | undefined): { key: string; day: string } | null {
  const match = value ? /^([A-Z]{2,5}):(\d{4}-\d{2}-\d{2})$/.exec(value) : null;
  return match?.[1] && match[2] ? { key: match[1], day: match[2] } : null;
}

/**
 * Schedule > Days (B4, G-38): every project's day types as a table, a calendar or a list, with the day editor, the
 * day grid (G-41) and day templates (G-42) on each day. Reads with the viewer's client, so row level security decides
 * which projects' days show, and the controls follow schedule.timeline.write and projects.template.write.
 */
export async function DaysPage({ ctx, search }: { ctx: OrgContext; search: SearchParams }) {
  const t = await getTranslate();
  const db = ctx.viewer.db;
  const node = "schedule.days";
  const { views, defaultView } = nodeViews(node);
  const requested = param(search, "view");
  const view = requested && views.includes(requested) ? requested : defaultView;
  const [meta, caps] = await Promise.all([loadRecordMeta(ctx), capabilitySet(ctx)]);
  const projectKey = param(search, "project") ?? "";
  const filtered = projectKey ? meta.projects.filter((p) => p.key === projectKey) : meta.projects;
  const projectIds = filtered.map((p) => p.id);
  const today = todayIn(filtered.length === 1 ? filtered[0]?.timeZone : await getOrgTimeZone(ctx));
  const monthParam = param(search, "month");
  const month =
    monthParam && /^\d{4}-\d{2}-01$/.test(monthParam) ? monthParam : `${today.slice(0, 7)}-01`;

  const [days, venues, shows, teams, templates, runs] = await Promise.all([
    listProjectDays(db, { orgId: ctx.org.id, projectIds }),
    listVenues(db, ctx.org.id),
    listShowNodes(db, projectIds),
    listCanonTeams(db),
    listDayTemplates(db, ctx.org.id),
    listRunsOfShow(db, { orgId: ctx.org.id }),
  ]);

  // The day grid, when it is open: the day's live, non-Canceled records, read on the project's wall clock.
  let grid: DayGridSource | null = null;
  const gridRef = dayRef(param(search, "grid"));
  const gridProject = gridRef ? meta.projects.find((p) => p.key === gridRef.key) : undefined;
  if (gridRef && gridProject) {
    const records = must(
      await listRecords(db, {
        orgId: ctx.org.id,
        projectId: gridProject.id,
        datedOnly: true,
        excludeStates: ["Canceled"],
      }),
      "records",
    );
    grid = {
      project: gridProject,
      day: gridRef.day,
      records: records.filter((r) => {
        const at = r.startsAt ?? r.dueAt;
        return at !== null && todayIn(gridProject.timeZone, new Date(at)) === gridRef.day;
      }),
    };
  }

  return (
    <DaysCollection
      org={ctx.org.slug}
      title={t(getNode(sitemap, node).node.label)}
      views={views}
      view={view}
      month={month}
      today={today}
      projectKey={projectKey}
      projects={meta.projects}
      days={must(days, "project days")}
      venues={must(venues, "venues")}
      shows={must(shows, "show nodes")}
      teams={must(teams, "teams")}
      templates={must(templates, "day templates")}
      runs={must(runs, "running orders").map((r) => ({
        id: r.id,
        projectId: r.projectId,
        name: r.name,
        showDate: r.showDate,
      }))}
      kinds={meta.kinds.map((k) => ({ kind: k.kind, recordClass: k.recordClass }))}
      people={meta.people.map((p) => ({ id: p.personId, name: p.name }))}
      canWrite={caps.has("schedule.timeline.write")}
      canTemplate={caps.has("projects.template.write")}
      editing={dayRef(param(search, "day"))}
      applying={dayRef(param(search, "apply"))}
      saving={dayRef(param(search, "save"))}
      grid={grid}
    />
  );
}
