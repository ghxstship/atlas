"use server";

import { listActivity } from "@xos/data/activity";
import { getProjectDebrief, listDebriefItems } from "@xos/data/debriefs";
import { addCalendarDays, startOfDayIn, todayIn, zoneOrUtc } from "@xos/data/calendar";
import { getFormatter } from "next-intl/server";
import { z } from "zod";
import { getProjectContextFor } from "@/lib/projects/context";
import { weekOfActivity } from "./summary-items";

/**
 * What a project summary reads (A95, Section 4.7): for "this week", the project's activity of the
 * last seven days on the project's own calendar, today included (A71: never the UTC date); for gate
 * readiness, the project itself, to which aurora.summarize adds its next gate's criteria. Read as the
 * viewer, so the feed rule decides what they see, and labelled for the "what Aurora receives" list.
 * The summary itself goes through the public API, which meters it.
 */

export interface ProjectSummaryItems {
  readonly ok: true;
  readonly items: readonly { collection: string; id: string; label: string }[];
  /** The calendar days the week covers, on the project's calendar; null for gate readiness. */
  readonly window: { readonly from: string; readonly to: string } | null;
  /** True when the week held more activity than one summary reads. */
  readonly truncated: boolean;
}

const PAGE = 100;

const Input = z.object({
  org: z.string().min(1).max(100),
  projectKey: z.string().min(1).max(40),
  kind: z.enum(["project_week", "gate_readiness", "project_wrap_up"]),
});

export async function projectSummaryItemsAction(
  raw: unknown,
): Promise<ProjectSummaryItems | { readonly ok: false }> {
  const parsed = Input.safeParse(raw);
  if (!parsed.success) return { ok: false };
  const { org, projectKey, kind } = parsed.data;
  const ctx = await getProjectContextFor({ org, projectKey });
  if (!ctx) return { ok: false };
  const { project } = ctx;
  const subject = {
    collection: "projects",
    id: project.id,
    label: `${project.key} · ${project.name}`,
  };
  if (kind === "gate_readiness") {
    return { ok: true, items: [subject], window: null, truncated: false };
  }
  // A wrap-up reads the project and its debrief points; aurora.summarize adds the budget, incident and measurement
  // facts the viewer may read (B7).
  if (kind === "project_wrap_up") {
    const debrief = await getProjectDebrief(ctx.org.viewer.db, project.id);
    const points =
      debrief.ok && debrief.data
        ? await listDebriefItems(ctx.org.viewer.db, debrief.data.id)
        : null;
    return {
      ok: true,
      items: [
        subject,
        ...(points?.ok ? points.data : []).map((p) => ({
          collection: "project-debrief-items",
          id: p.id,
          label: p.body.length > 80 ? `${p.body.slice(0, 80)}…` : p.body,
        })),
      ],
      window: null,
      truncated: false,
    };
  }
  const zone = zoneOrUtc(project.timeZone);
  const to = todayIn(zone);
  const from = addCalendarDays(to, -6);
  const since = startOfDayIn(from, zone);
  const db = ctx.org.viewer.db;
  const week = await weekOfActivity(async (before) => {
    const result = await listActivity(db, {
      orgId: ctx.org.org.id,
      projectId: project.id,
      before,
      limit: PAGE,
    });
    if (!result.ok)
      throw new Error(`Cannot read project activity: ${JSON.stringify(result.error)}`);
    return result.data;
  }, since);
  const format = await getFormatter();
  const items = week.entries.map((e) => ({
    collection: "activity-events",
    id: e.id,
    label: [
      format.dateTime(new Date(e.at), { dateStyle: "medium", timeZone: zone }),
      e.description ?? e.type,
      e.recordKey ?? e.recordTitle,
    ]
      .filter((part): part is string => typeof part === "string" && part !== "")
      .join(" · "),
  }));
  return { ok: true, items, window: { from, to }, truncated: week.truncated };
}
