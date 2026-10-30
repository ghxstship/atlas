import type { TimelineModel } from "@xos/data/schedule";
import type { TimelineCategory, TimelineProps } from "@xos/ui";
import type { useFormatter } from "next-intl";
import { stateToken } from "@/components/work/format";

/** What a schedule page adds to its timeline (B4): each date's day-type tags and the project's anchor day. */
export interface TimelineExtras {
  readonly dayTypes?:
    readonly { readonly date: string; readonly tags: readonly TimelineCategory[] }[] | undefined;
  readonly anchor?: { readonly day: string; readonly label: string } | null | undefined;
}

/**
 * The @xos/ui Timeline props for a laid-out timeline: days named in the locale, bars by record state,
 * and the dependencies between drawn bars, which the reschedule preview pushes along (A133). With
 * extras, days carry their day-type tags and the anchor day draws as a gate that the table's Offset
 * column counts from (B4).
 */
export function timelineView(
  timeline: TimelineModel,
  format: ReturnType<typeof useFormatter>,
  extras: TimelineExtras = {},
): Omit<TimelineProps, "label"> {
  const tags = new Map((extras.dayTypes ?? []).map((d) => [d.date, d.tags]));
  const anchorIndex = extras.anchor
    ? timeline.days.findIndex((d) => d.day === extras.anchor?.day)
    : -1;
  return {
    ...(anchorIndex >= 0 && extras.anchor
      ? { anchorDay: anchorIndex, gates: [{ day: anchorIndex, label: extras.anchor.label }] }
      : {}),
    days: timeline.days.map((d) => {
      const noon = new Date(`${d.day}T12:00:00Z`);
      return {
        dow: format.dateTime(noon, { weekday: "narrow", timeZone: "UTC" }),
        date: d.date,
        weekend: d.weekend,
        label: format.dateTime(noon, {
          weekday: "long",
          month: "long",
          day: "numeric",
          timeZone: "UTC",
        }),
        ...(tags.get(d.day)?.length ? { tags: [...(tags.get(d.day) ?? [])] } : {}),
      };
    }),
    dayWidth: timeline.days.length > 60 ? 16 : 32,
    ...(timeline.today !== undefined ? { today: timeline.today } : {}),
    rows: timeline.bars.map((b) => ({
      key: b.record.key,
      title: b.record.title,
      state: stateToken(b.record.state),
      start: b.start,
      end: b.end,
      ...(b.milestone ? { milestone: true } : {}),
      ...(b.dependsOn !== undefined ? { dependsOn: b.dependsOn } : {}),
      ...(b.baselineStart !== undefined ? { baselineStart: b.baselineStart } : {}),
      ...(b.baselineEnd !== undefined ? { baselineEnd: b.baselineEnd } : {}),
      ...(b.locked ? { locked: true } : {}),
    })),
    links: (timeline.edges ?? []).map((e) => ({
      from: e.from,
      to: e.to,
      type: e.type,
      lagDays: e.lagHours / 24,
    })),
  };
}
