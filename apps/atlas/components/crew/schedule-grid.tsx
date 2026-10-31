import type { Shift } from "@xos/data/crew";
import Link from "next/link";
import type { Route } from "next";
import { getFormatter } from "next-intl/server";
import { stateIcon } from "@/lib/crew/states";
import { addDays, dayIn, hoursFromMinutes } from "@/lib/crew/time";
import { getTranslate } from "@/lib/shell/translate";
import { Avatar, StateIcon } from "./ui";

/**
 * The resource schedule (Section 11.15: shifts default to it in Atlas): people down the side, the
 * week across, each shift a chip that opens its side peek. Open shifts sit on their own row. A day
 * with two shifts for one person is marked as a double booking, and weekly hours over the canon
 * wage-hour threshold of the project's jurisdiction are flagged so planners see overtime before they publish. It is a real table, so
 * it is its own accessible alternative.
 */
export async function ScheduleGrid(props: {
  shifts: readonly Shift[];
  weekStart: string;
  roleTitles: ReadonlyMap<string, { title: string }>;
  peekHref: (id: string) => string;
  label: string;
  /** Weekly overtime threshold in hours by project, from its canon wage-hour rule; null is no answer. */
  overtimeHours: ReadonlyMap<string, number | null>;
  /** A short label per shift, such as Needs review (B6), shown on its chip. */
  notes?: ReadonlyMap<string, string>;
}) {
  const t = await getTranslate();
  const format = await getFormatter();
  const days = Array.from({ length: 7 }, (_, i) => addDays(props.weekStart, i));
  type Row = { key: string; name: string; role: string; shifts: Shift[] };
  const rows = new Map<string, Row>();
  const open: Shift[] = [];
  for (const s of props.shifts) {
    if (!s.member) {
      open.push(s);
      continue;
    }
    const key = s.member.personId ?? s.member.membershipId;
    const row = rows.get(key) ?? {
      key,
      name: s.member.name ?? t("crew.common.unnamed"),
      role: s.roleCode ? (props.roleTitles.get(s.roleCode)?.title ?? s.roleCode) : "",
      shifts: [],
    };
    row.shifts.push(s);
    rows.set(key, row);
  }
  const people = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (open.length > 0) {
    people.push({ key: "open", name: t("crew.shifts.openRow"), role: "", shifts: open });
  }

  const chip = (s: Shift) => {
    const live = s.state !== "Canceled";
    return (
      <Link
        key={s.id}
        href={props.peekHref(s.id) as Route}
        className={
          live
            ? "mb-2 flex items-center gap-4 rounded-chip bg-bg-hover px-6 py-2 text-text-12 text-text-primary hover:bg-bg-surface"
            : "mb-2 flex items-center gap-4 rounded-chip px-6 py-2 text-text-12 text-text-tertiary line-through"
        }
      >
        <StateIcon state={stateIcon("shift", s.state)} size={12} />
        <span className="tabular-nums">
          {format.dateTime(new Date(s.startsAt), { timeZone: s.timeZone, timeStyle: "short" })}
        </span>
        <span className="sr-only">
          {t("crew.shifts.chipLabel", {
            state: t(`crew.states.shift.${s.state}`),
            project: s.projectKey,
          })}
        </span>
        {props.notes?.get(s.id) ? (
          <span className="font-medium text-warning-text">{props.notes.get(s.id)}</span>
        ) : null}
      </Link>
    );
  };

  return (
    <div
      role="region"
      aria-label={props.label}
      tabIndex={0}
      className="overflow-x-auto rounded-card border border-border-subtle"
    >
      <table className="w-full border-collapse text-text-13">
        <caption className="sr-only">{props.label}</caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="h-control-lg border-b border-border-subtle bg-bg-surface px-12 text-start text-text-12 font-medium text-text-secondary"
            >
              {t("crew.shifts.person")}
            </th>
            {days.map((d) => (
              <th
                key={d}
                scope="col"
                className="h-control-lg border-b border-border-subtle bg-bg-surface px-12 text-start text-text-12 font-medium"
              >
                {format.dateTime(new Date(`${d}T12:00:00Z`), {
                  timeZone: "UTC",
                  weekday: "short",
                  day: "numeric",
                })}
              </th>
            ))}
            <th
              scope="col"
              className="h-control-lg border-b border-border-subtle bg-bg-surface px-12 text-end text-text-12 font-medium text-text-secondary"
            >
              {t("crew.shifts.weekHours")}
            </th>
          </tr>
        </thead>
        <tbody>
          {people.map((p) => {
            const minutes = p.shifts
              .filter((s) => s.state !== "Canceled")
              .reduce(
                (sum, s) => sum + (Date.parse(s.endsAt) - Date.parse(s.startsAt)) / 60_000,
                0,
              );
            const hours = hoursFromMinutes(minutes);
            const thresholds = p.shifts
              .map((s) => props.overtimeHours.get(s.projectId) ?? null)
              .filter((h): h is number => h !== null);
            const over =
              p.key !== "open" && thresholds.length > 0 && hours > Math.min(...thresholds);
            return (
              <tr key={p.key}>
                <th
                  scope="row"
                  className="border-b border-border-subtle px-12 py-6 text-start font-normal"
                >
                  <span className="flex items-center gap-8 whitespace-nowrap">
                    {p.key === "open" ? null : <Avatar name={p.name} />}
                    <span className="flex flex-col">
                      <span>{p.name}</span>
                      {p.role ? (
                        <span className="text-text-12 text-text-secondary">{p.role}</span>
                      ) : null}
                    </span>
                  </span>
                </th>
                {days.map((d) => {
                  const today = p.shifts.filter((s) => dayIn(s.startsAt, s.timeZone) === d);
                  const clash =
                    p.key !== "open" && today.filter((s) => s.state !== "Canceled").length > 1;
                  return (
                    <td
                      key={d}
                      className={
                        clash
                          ? "min-w-(--space-64) border-b border-border-subtle px-12 py-6 align-top ring-(length:--stroke-width-focus) ring-inset ring-danger"
                          : "min-w-(--space-64) border-b border-border-subtle px-12 py-6 align-top"
                      }
                    >
                      {today.map(chip)}
                      {clash ? (
                        <span className="text-text-11 font-medium text-danger-text">
                          {t("crew.shifts.doubleBooked")}
                        </span>
                      ) : null}
                    </td>
                  );
                })}
                <td className="border-b border-border-subtle px-12 py-6 text-end align-top tabular-nums">
                  <span className={over ? "font-medium text-warning-text" : undefined}>
                    {format.number(hours, { maximumFractionDigits: 2 })}
                  </span>
                  {over ? (
                    <span className="block text-text-11 text-warning-text">
                      {t("crew.shifts.overtimeRisk")}
                    </span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
