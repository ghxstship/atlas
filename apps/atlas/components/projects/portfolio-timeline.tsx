"use client";

import type { ProjectSummary } from "@xos/data/projects";
import { dayTypeSlug, dayTypeTone } from "@xos/data/schedule-day-tones";
import type { DayType } from "@xos/data/schedule-days";
import { EmptyState, Link, Tag, type TimelineSegment } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { stateIcon } from "@/lib/projects/format";
import { Timeline } from "@/components/lazy-ui/timeline";
import { portfolioOverlayAction } from "@/components/schedule/depth-actions";
import { useCopy } from "@/components/work/action-ui";

const DAY = 86_400_000;

interface Overlay {
  readonly days: readonly {
    readonly projectId: string;
    readonly dayOn: string;
    readonly dayType: DayType;
  }[];
  readonly clashes: Readonly<Record<string, number>>;
}

/** Runs of consecutive days of one type, as row segments by day index. */
export function daySegments(
  days: readonly { readonly dayOn: string; readonly dayType: DayType }[],
  index: (ms: number) => number,
  name: (type: DayType) => string,
): TimelineSegment[] {
  const sorted = [...days].sort((a, b) => a.dayOn.localeCompare(b.dayOn));
  const out: TimelineSegment[] = [];
  for (const d of sorted) {
    const at = index(Date.parse(`${d.dayOn}T00:00:00Z`));
    const last = out.at(-1);
    if (last && last.end === at - 1 && last.label === name(d.dayType)) {
      out[out.length - 1] = { ...last, end: at };
    } else {
      const tone = dayTypeTone(d.dayType);
      out.push({
        label: name(d.dayType),
        category: tone.category,
        icon: tone.icon,
        start: at,
        end: at,
      });
    }
  }
  return out;
}

/**
 * Projects on a day grid from the earliest start to the latest end (Timeline view). Once drawn, it asks for each
 * production's Load In, Show and Load Out days, drawn as labelled segments in its row (build-up, show and strike
 * across productions), and its clashes over the next 90 days, each count linked to the filtered register (B4). That
 * read happens only here, after the page has painted.
 */
export function PortfolioTimeline({
  org,
  projects,
  label,
  today,
  format,
  onAddDates,
}: {
  org: string;
  projects: readonly ProjectSummary[];
  label: string;
  today: string;
  format: (d: Date) => string;
  onAddDates: (key: string) => void;
}) {
  const t = useTranslations("projects");
  const s = useCopy("schedule");
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const dated = projects.filter((p) => p.startsOn || p.endsOn);
  const ids = dated.map((p) => p.id).join(",");
  useEffect(() => {
    if (ids === "") return;
    let live = true;
    void portfolioOverlayAction(org, { projectIds: ids.split(","), from: today }).then((result) => {
      if (live && result.ok) setOverlay(result.data);
    });
    return () => {
      live = false;
    };
  }, [org, ids, today]);
  const first0 = projects[0];
  if (dated.length === 0) {
    return first0 ? (
      <EmptyState
        icon="CalendarRange"
        sentence={t("list.addDates")}
        actionLabel={t("list.open")}
        onAction={() => onAddDates(first0.key)}
      />
    ) : null;
  }
  const time = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
  const starts = dated.map((p) => time((p.startsOn ?? p.endsOn) as string));
  const ends = dated.map((p) => time((p.endsOn ?? p.startsOn) as string));
  const first = Math.min(...starts);
  const last = Math.min(Math.max(...ends), first + 365 * DAY);
  const count = Math.round((last - first) / DAY) + 1;
  const days = Array.from({ length: count }, (_, i) => {
    const d = new Date(first + i * DAY);
    const dow = d.getUTCDay();
    return { dow: format(d), date: d.getUTCDate(), weekend: dow === 0 || dow === 6 };
  });
  const index = (ms: number) => Math.max(0, Math.min(count - 1, Math.round((ms - first) / DAY)));
  const todayIndex = Math.round((time(today) - first) / DAY);
  const typeName = (type: DayType) => s(`days.types.${dayTypeSlug(type)}`);
  const counted = dated.filter((p) => (overlay?.clashes[p.id] ?? 0) > 0);
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <Timeline
        label={label}
        days={days}
        dayWidth={count > 120 ? 8 : count > 45 ? 16 : 32}
        {...(todayIndex >= 0 && todayIndex < count ? { today: todayIndex } : {})}
        rows={dated.map((p, i) => {
          const segments = overlay
            ? daySegments(
                overlay.days.filter((d) => d.projectId === p.id),
                index,
                typeName,
              )
            : [];
          return {
            key: p.key,
            title: p.name,
            state: stateIcon(p.projectState),
            start: index(starts[i] ?? first),
            end: index(ends[i] ?? first),
            ...(segments.length > 0 ? { segments } : {}),
          };
        })}
      />
      {counted.length > 0 ? (
        <ul className="m-0 flex list-none flex-wrap gap-8 p-0" aria-label={s("clashes.portfolio")}>
          {counted.map((p) => (
            <li key={p.id} className="inline-flex items-center gap-4">
              <Tag tone="warning">{p.key}</Tag>
              <Link href={`/${org}/schedule/clashes?project=${p.key}`}>
                {s("clashes.count", { count: overlay?.clashes[p.id] ?? 0 })}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
