import { useState, type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useLocale, useT } from "../lib/context.tsx";
import {
  formatDate,
  monthCells,
  monthTitle,
  parseIso,
  toIso,
  weekdayNames,
} from "../lib/format.ts";
import { StateIcon } from "../StateIcon/StateIcon.tsx";
import { SegmentedControl } from "../Navigation/Navigation.tsx";
import { type CalendarProps } from "./Charts.types.ts";

/** Dated records by month or agenda with state icons. */
export function Calendar({ month, today, events, onEventSelect }: CalendarProps): ReactElement {
  const t = useT();
  const locale = useLocale();
  const [view, setView] = useState("month");
  const { y, m } = parseIso(month);
  const title = monthTitle(locale, y, m);
  const byDate = new Map<string, CalendarProps["events"]>();
  for (const e of events) byDate.set(e.date, [...(byDate.get(e.date) ?? []), e]);
  const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date));
  const eventButton = (e: CalendarProps["events"][number], i: number) => (
    <button
      key={`${e.label}-${i}`}
      type="button"
      onClick={() => onEventSelect?.(e)}
      className="flex items-center gap-4 w-full min-h-(--space-24) px-4 py-2 rounded-chip border-0 bg-bg-hover text-start text-text-12 truncate cursor-pointer"
    >
      <StateIcon state={e.state} size={12} />
      <span className="truncate">{e.label}</span>
    </button>
  );
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-8">
        <h2 className="m-0 text-heading-16 font-semibold">{title}</h2>
        <SegmentedControl
          label={t("calendar.range")}
          value={view}
          onChange={setView}
          options={[
            { value: "month", label: t("calendar.month") },
            { value: "agenda", label: t("calendar.agenda") },
          ]}
        />
      </div>
      {view === "agenda" ? (
        <ol className="flex flex-col m-0 p-0 list-none">
          {sorted.map((e, i) => (
            <li
              key={`${e.date}-${i}`}
              className="grid grid-cols-[var(--ui-props-label)_minmax(0,1fr)] items-center gap-8 min-h-row-default border-b border-border-subtle"
            >
              <time dateTime={e.date} className="text-text-secondary tabular-nums">
                {formatDate(locale, e.date)}
              </time>
              {eventButton(e, i)}
            </li>
          ))}
        </ol>
      ) : (
        <table
          aria-label={title}
          className="w-full table-fixed border-collapse border-s border-t border-border-subtle"
        >
          <thead>
            <tr>
              {weekdayNames(locale).map((d) => (
                <th
                  key={d}
                  scope="col"
                  className="p-6 max-sm:px-2 text-center text-text-11 font-medium text-text-secondary bg-bg-surface border-e border-b border-border-subtle"
                >
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {monthCells(locale, y, m).map((week, wi) => (
              <tr key={wi}>
                {week.map((d, di) => {
                  const iso = d === null ? null : toIso(y, m, d);
                  const dayEvents = iso ? (byDate.get(iso) ?? []) : [];
                  return (
                    <td
                      key={di}
                      className={cx(
                        "min-h-(--space-64) p-4 align-top border-e border-b border-border-subtle text-text-12",
                        d === null && "bg-bg-surface",
                      )}
                    >
                      {d !== null ? (
                        <div className="flex flex-col gap-2">
                          <span
                            aria-current={iso === today ? "date" : undefined}
                            className={cx(
                              "self-start px-4 py-2 rounded-chip text-text-11 text-text-secondary tabular-nums",
                              iso === today &&
                                "text-text-primary font-semibold ring-(length:--stroke-width-focus) ring-inset ring-accent",
                            )}
                          >
                            {d}
                          </span>
                          {dayEvents.slice(0, 3).map(eventButton)}
                          {dayEvents.length > 3 ? (
                            <span className="text-text-secondary">
                              {t("calendar.more", { n: dayEvents.length - 3 })}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
