"use client";

import type { ProjectSummary } from "@xos/data/projects";
import { EmptyState } from "@xos/ui";
import { useTranslations } from "next-intl";
import { stateIcon } from "@/lib/projects/format";
import { Timeline } from "@/components/lazy-ui/timeline";

const DAY = 86_400_000;

/** Projects on a day grid from the earliest start to the latest end (Timeline view). */
export function PortfolioTimeline({
  projects,
  label,
  today,
  format,
  onAddDates,
}: {
  projects: readonly ProjectSummary[];
  label: string;
  today: string;
  format: (d: Date) => string;
  onAddDates: (key: string) => void;
}) {
  const t = useTranslations("projects");
  const dated = projects.filter((p) => p.startsOn || p.endsOn);
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
  return (
    <div className="min-w-0">
      <Timeline
        label={label}
        days={days}
        dayWidth={count > 120 ? 8 : count > 45 ? 16 : 32}
        {...(todayIndex >= 0 && todayIndex < count ? { today: todayIndex } : {})}
        rows={dated.map((p, i) => ({
          key: p.key,
          title: p.name,
          state: stateIcon(p.projectState),
          start: index(starts[i] ?? first),
          end: index(ends[i] ?? first),
        }))}
      />
    </div>
  );
}
