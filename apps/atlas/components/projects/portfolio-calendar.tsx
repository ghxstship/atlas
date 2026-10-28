"use client";

import type { ProjectSummary } from "@xos/data/projects";
import { Button, Calendar, type RecordState } from "@xos/ui";
import { useTranslations } from "next-intl";
import { stateIcon } from "@/lib/projects/format";

/**
 * Projects starting and ending in a month (Calendar view), with the previous and next month. It loads when the
 * Calendar view is shown, not with the list (A24-009).
 */
export function PortfolioCalendar({
  projects,
  month,
  today,
  onMonth,
  onOpen,
}: {
  projects: readonly ProjectSummary[];
  /** The first of the month shown, `2026-11-01`. */
  month: string;
  today: string;
  onMonth: (month: string) => void;
  /** Opens a project's peek by key. */
  onOpen: (key: string | null) => void;
}) {
  const t = useTranslations("projects");
  const byLabel = new Map<string, string>();
  const events = projects.flatMap((p) => {
    const out: { date: string; label: string; state: RecordState }[] = [];
    const add = (iso: string | null, label: string) => {
      if (iso?.startsWith(month.slice(0, 7))) {
        byLabel.set(label, p.key);
        out.push({ date: iso, label, state: stateIcon(p.projectState) });
      }
    };
    add(p.startsOn, t("list.starts", { key: p.key }));
    add(p.endsOn, t("list.ends", { key: p.key }));
    return out;
  });
  return (
    <div className="flex flex-col gap-8">
      <div className="flex gap-8">
        <Button onClick={() => onMonth(shiftMonth(month, -1))}>{t("list.previousMonth")}</Button>
        <Button onClick={() => onMonth(shiftMonth(month, 1))}>{t("list.nextMonth")}</Button>
      </div>
      <Calendar
        month={month}
        today={today}
        events={events}
        onEventSelect={(e) => onOpen(byLabel.get(e.label) ?? null)}
      />
    </div>
  );
}

/** `2026-11-01` moved by whole months, as the first of that month. */
function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 10);
}
