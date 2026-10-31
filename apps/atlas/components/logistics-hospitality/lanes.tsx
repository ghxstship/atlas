import type { RecordState } from "@xos/ui";
import type { Route } from "next";
import Link from "next/link";
import { StateIcon } from "./ui";

/**
 * The resource schedule of the B5 pages (ADR 0144), as dock.tsx lays out docks: one row per lane (a driver, a vehicle
 * or a space) and one column per day, each item a link to its peek. Items are placed by the day they start on in
 * their own zone, which the caller works out.
 */
export interface LaneItem {
  readonly id: string;
  readonly day: string;
  readonly label: string;
  readonly state: RecordState;
  readonly href: string;
}

export interface Lane {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly items: readonly LaneItem[];
}

export function LaneSchedule({
  caption,
  laneHeading,
  days,
  dayLabel,
  lanes,
}: {
  caption: string;
  laneHeading: string;
  days: readonly string[];
  dayLabel: (day: string) => { weekday: string; date: string };
  lanes: readonly Lane[];
}) {
  return (
    <div
      role="region"
      aria-label={caption}
      tabIndex={0}
      className="overflow-x-auto rounded-card border border-border-subtle"
    >
      <table className="w-full min-w-(--layout-reading) border-collapse text-text-13">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="h-control-lg px-12 text-start text-text-12 font-medium text-text-secondary bg-bg-surface border-b border-border-subtle"
            >
              {laneHeading}
            </th>
            {days.map((d) => {
              const label = dayLabel(d);
              return (
                <th
                  key={d}
                  scope="col"
                  className="h-control-lg px-12 text-start text-text-12 font-medium bg-bg-surface border-b border-border-subtle"
                >
                  <span className="text-text-secondary">{label.weekday}</span>{" "}
                  <span className="tabular-nums">{label.date}</span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {lanes.map((lane) => (
            <tr key={lane.id}>
              <th
                scope="row"
                className="px-12 py-8 text-start align-top font-medium border-b border-border-subtle"
              >
                {lane.label}
                {lane.detail ? (
                  <>
                    <br />
                    <span className="text-text-12 font-normal text-text-secondary">
                      {lane.detail}
                    </span>
                  </>
                ) : null}
              </th>
              {days.map((d) => (
                <td key={d} className="px-8 py-8 align-top border-b border-s border-border-subtle">
                  <ul className="m-0 flex list-none flex-col gap-4 p-0">
                    {lane.items
                      .filter((i) => i.day === d)
                      .map((i) => (
                        <li key={i.id}>
                          <Link
                            href={i.href as Route}
                            scroll={false}
                            className="flex items-start gap-4 rounded-chip bg-bg-surface px-6 py-4 text-text-12 text-text-primary outline-none hover:bg-bg-hover focus-visible:ring-(length:--stroke-width-focus) focus-visible:ring-focus-ring"
                          >
                            <StateIcon state={i.state} size={12} />
                            <span>{i.label}</span>
                          </Link>
                        </li>
                      ))}
                  </ul>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The seven days of the week starting on `monday` (YYYY-MM-DD). */
export function weekDays(monday: string): string[] {
  const start = Date.parse(`${monday}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, i) =>
    new Date(start + i * 86_400_000).toISOString().slice(0, 10),
  );
}

/** The Monday on or before a day (YYYY-MM-DD). */
export function mondayOf(day: string): string {
  const at = new Date(`${day}T00:00:00Z`);
  const offset = (at.getUTCDay() + 6) % 7;
  return new Date(at.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
}

/** The current instant in milliseconds, read once per request by the server sections that compare times. */
export function nowMs(): number {
  return Date.now();
}
