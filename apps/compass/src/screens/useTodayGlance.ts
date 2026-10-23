/**
 * Today at a glance, for the widgets, the Live Activity's next cue and the Android ongoing notification
 * (A65-011 part 4): the person's shifts today across every org and the soonest next cue, each on its own
 * project's calendar (src/domain/orgs.ts combinedToday).
 */
import type { Row } from "@xos/sync";
import * as Linking from "expo-linking";
import { useTranslation } from "react-i18next";
import type { GlanceCue, GlanceShift, Translate, WidgetPayload } from "../domain/glance";
import { widgetPayload } from "../domain/glance";
import { combinedToday, itemZone, type TodayCue, type TodaySheet } from "../domain/orgs";
import { scheduleZone } from "../domain/settings";
import type { ShiftRow } from "../domain/shifts";
import { useCompass, useRows } from "../runtime/CompassProvider";
import { formatTime, useRoleTitle } from "./common";

export interface TodayGlance {
  readonly shifts: readonly GlanceShift[];
  readonly cue: GlanceCue | null;
  readonly widget: WidgetPayload | null;
  /** The app link the widgets and the notification open: Today. */
  readonly link: string;
}

export function useTodayGlance(): TodayGlance {
  const { t } = useTranslation();
  const roleTitle = useRoleTitle();
  const { resolved, personZone, brands, orgSettings } = useCompass();
  // Times read in the item's zone, or the person's own when they asked for that (me.time_zone_display, A97).
  const display = (zone: string) => scheduleZone(zone, orgSettings) ?? zone;
  const all = { allOrgs: true } as const;
  const { rows: shifts } = useRows<ShiftRow & Row>("shifts", undefined, all);
  const { rows: sheets } = useRows<TodaySheet & Row>("day_sheets", undefined, all);
  const { rows: cues } = useRows<TodayCue & Row>("cues", undefined, all);
  const { rows: projects } = useRows<Row & { name?: string; time_zone?: string | null }>(
    "projects",
    undefined,
    all,
  );
  const link = Linking.createURL("/today");
  if (!resolved) return { shifts: [], cue: null, widget: null, link };
  const now = Date.now();
  const several = resolved.contexts.length > 1;
  const groups = combinedToday({
    orgs: resolved.contexts.map((c) => ({
      orgId: c.orgId,
      orgName: brands.get(c.orgId)?.name || c.orgName,
      projectIds: c.projects.map((p) => p.id),
      me: {
        membershipId: c.identity.membershipId,
        engagementIds: c.identity.engagements
          .filter((e) => e.state === "Active" || e.state === "Closing")
          .map((e) => e.id),
      },
    })),
    activeOrgId: resolved.orgId,
    shifts,
    sheets,
    cues,
    projects,
    personZone,
    nowMs: now,
  });
  const project = (id: string) => projects.find((p) => p.id === id);
  const glanceShifts: GlanceShift[] = groups.flatMap((g) =>
    g.shifts.map((s) => ({
      id: s.id,
      title: roleTitle(s),
      startsAt: s.starts_at,
      endsAt: s.ends_at,
      zone: display(itemZone(s.time_zone, project(s.project_id)?.time_zone, personZone)),
      org: several ? g.orgName : null,
    })),
  );
  let cue: GlanceCue | null = null;
  for (const g of groups) {
    const next = g.nextCue;
    if (!next?.planned_at) continue;
    const at = Date.parse(next.planned_at);
    if (cue && cue.at <= at) continue;
    const p = project(next.project_id ?? "");
    cue = {
      label: next.label,
      at,
      project: p?.name ?? null,
      zone: display(itemZone(null, p?.time_zone, personZone)),
    };
  }
  return {
    shifts: glanceShifts,
    cue,
    widget: widgetPayload(glanceShifts, cue, t as Translate, formatTime, link),
    link,
  };
}
