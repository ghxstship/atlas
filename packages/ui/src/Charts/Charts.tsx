import {
  Children,
  isValidElement,
  useId,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import type {
  CalendarProps as ReferenceCalendarProps,
  GalleryProps as ReferenceGalleryProps,
  OrgChartNode,
  OrgChartProps as ReferenceOrgChartProps,
  ResourceScheduleProps as ReferenceResourceScheduleProps,
  TimelineProps as ReferenceTimelineProps,
} from "../types/reference";
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
import { Icon } from "../Icon/Icon.tsx";
import { Avatar } from "../Avatar/Avatar.tsx";
import { StateIcon } from "../StateIcon/StateIcon.tsx";
import { SegmentedControl } from "../Navigation/Navigation.tsx";
import { ScrollRegion } from "../Layout/Layout.tsx";

export type GalleryProps = ReferenceGalleryProps;
export type CalendarProps = ReferenceCalendarProps & {
  onEventSelect?: (event: ReferenceCalendarProps["events"][number]) => void;
};
export type TimelineProps = ReferenceTimelineProps;
export type ResourceScheduleProps = ReferenceResourceScheduleProps;
export type OrgChartProps = ReferenceOrgChartProps;
export { Sparkline, type SparklineProps } from "./Sparkline.tsx";
export { Chart, foldSeries, type ChartProps } from "./Chart.tsx";

/** Cards on an auto-filling grid; `min` sets the smallest card width in pixels (240 by default). */
export function Gallery({ label, min, children }: GalleryProps): ReactElement {
  const items = Children.toArray(children).filter((c) => !(typeof c === "string" && !c.trim()));
  const style = {
    "--xos-gallery-min":
      min === undefined ? "calc(var(--space-40) * 6)" : `calc(var(--space-4) * ${min / 4})`,
  } as CSSProperties;
  return (
    <div
      role="list"
      aria-label={label}
      style={style}
      className="grid grid-cols-[repeat(auto-fill,minmax(min(var(--xos-gallery-min),100%),1fr))] gap-16"
    >
      {items.map((child, i) => (
        <div role="listitem" key={isValidElement(child) && child.key !== null ? child.key : i}>
          {child}
        </div>
      ))}
    </div>
  );
}

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

const TL_BAR: Record<string, string> = {
  active: cx("bg-accent"),
  complete: cx("bg-success opacity-85"),
  blocked: cx("bg-bg-hover ring-(length:--ui-hairline-half) ring-inset ring-danger"),
};

/**
 * The Gantt view: bars by state, baselines, dependencies, gate markers, today and the critical path.
 * The drawing is hidden from assistive technology; a table beside it carries every row.
 */
export function Timeline({
  label,
  days,
  rows,
  gates = [],
  today,
  dayWidth = 32,
}: TimelineProps): ReactElement {
  const t = useT();
  const markerId = `${useId().replace(/:/g, "")}-arrow`;
  const rowH = 36;
  const width = days.length * dayWidth;
  const height = rows.length * rowH;
  const dayLabel = (i: number) => {
    const d = days[i];
    return d ? `${d.dow} ${d.date}` : "";
  };
  return (
    <figure aria-label={label} className="relative m-0">
      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            {[
              "timeline.key",
              "timeline.record",
              "timeline.state",
              "timeline.start",
              "timeline.end",
              "timeline.dependsOn",
            ].map((k) => (
              <th key={k} scope="col">
                {t(k)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.key}</td>
              <td>
                {r.title}
                {r.milestone ? ` (${t("timeline.milestone")})` : ""}
                {r.critical ? ` (${t("timeline.critical")})` : ""}
              </td>
              <td>{r.state}</td>
              <td>{dayLabel(r.start)}</td>
              <td>{dayLabel(r.end)}</td>
              <td>{r.dependsOn !== undefined ? (rows[r.dependsOn]?.key ?? "") : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex overflow-hidden rounded-card border border-border-subtle bg-bg-canvas">
        <div
          aria-hidden="true"
          className="flex-none w-(--ui-tree) max-sm:w-(--ui-skeleton-inline) bg-bg-surface border-e border-border-subtle"
        >
          <div className="flex items-center h-(--ui-shell-head) px-12 font-semibold border-b border-border-subtle">
            {label}
          </div>
          {rows.map((r) => (
            <div
              key={r.key}
              className="flex items-center gap-6 h-row-default px-12 whitespace-nowrap overflow-hidden"
            >
              <StateIcon state={r.state} />
              <span className="font-mono text-text-12 text-text-secondary">{r.key}</span>
              <span className="truncate">{r.title}</span>
            </div>
          ))}
        </div>
        {/* The day grid scrolls sideways; the region takes keyboard focus when it overflows, so
            arrow keys reach the later dates (2.1.1). Its drawing stays hidden: the table above
            carries the data. */}
        <ScrollRegion label={t("timeline.scroll", { label })} className="flex-1 min-w-0">
          <div aria-hidden="true">
            <div
              className="flex h-(--ui-shell-head) border-b border-border-subtle"
              style={{ inlineSize: width }}
            >
              {days.map((d, i) => (
                <div
                  key={i}
                  style={{ inlineSize: dayWidth }}
                  className={cx(
                    "flex flex-none flex-col items-center justify-center text-text-11 text-text-tertiary",
                    d.weekend && "bg-bg-surface",
                  )}
                >
                  <span>{d.dow}</span>
                  <strong className="text-text-12 font-medium text-text-secondary tabular-nums">
                    {d.date}
                  </strong>
                </div>
              ))}
            </div>
            <div className="relative" style={{ inlineSize: width, blockSize: height }}>
              {days.map((d, i) =>
                d.weekend ? (
                  <div
                    key={i}
                    className="absolute inset-y-0 bg-bg-surface"
                    style={{ insetInlineStart: i * dayWidth, inlineSize: dayWidth }}
                  />
                ) : null,
              )}
              {rows.map((r, i) => {
                const top = i * rowH;
                return (
                  <div key={r.key}>
                    {r.baselineStart !== undefined && r.baselineEnd !== undefined ? (
                      <div
                        className="absolute h-(--space-4) rounded-pill bg-text-tertiary opacity-60"
                        style={{
                          insetInlineStart: r.baselineStart * dayWidth,
                          inlineSize: (r.baselineEnd - r.baselineStart + 1) * dayWidth,
                          insetBlockStart: top + 26,
                        }}
                      />
                    ) : null}
                    {r.milestone ? (
                      <div
                        className="absolute size-(--space-12) rotate-45 rounded-mark bg-warning"
                        style={{
                          insetInlineStart: r.start * dayWidth + dayWidth / 2 - 6,
                          insetBlockStart: top + 12,
                        }}
                      />
                    ) : (
                      <div
                        className={cx(
                          "absolute h-(--space-20) overflow-hidden rounded-chip",
                          TL_BAR[r.state] ??
                            "bg-bg-hover ring-(length:--stroke-width-hairline) ring-inset ring-border-strong",
                          r.critical && "ring-(length:--stroke-width-focus) ring-inset ring-danger",
                          "forced-colors:bg-[Highlight]",
                        )}
                        style={{
                          insetInlineStart: r.start * dayWidth + 2,
                          inlineSize: (r.end - r.start + 1) * dayWidth - 4,
                          insetBlockStart: top + 8,
                        }}
                      >
                        {r.progress !== undefined ? (
                          <span
                            className="block h-full bg-viz-ink opacity-20"
                            style={{ inlineSize: `${r.progress}%` }}
                          />
                        ) : null}
                      </div>
                    )}
                  </div>
                );
              })}
              {gates.map((g) => (
                <div
                  key={g.label}
                  className="absolute inset-y-0 border-s border-dashed border-state-in-review"
                  style={{ insetInlineStart: g.day * dayWidth }}
                >
                  <span className="absolute top-2 start-4 px-2 whitespace-nowrap text-text-11 text-text-secondary bg-bg-canvas">
                    {g.label}
                  </span>
                </div>
              ))}
              {today !== undefined ? (
                <div
                  className="absolute inset-y-0 w-(--stroke-width-focus) bg-danger"
                  style={{ insetInlineStart: today * dayWidth + dayWidth / 2 }}
                />
              ) : null}
              <svg
                className="absolute start-0 top-0 overflow-visible pointer-events-none rtl:-scale-x-100"
                width={width}
                height={height}
              >
                <defs>
                  <marker
                    id={markerId}
                    viewBox="0 0 8 8"
                    refX={7}
                    refY={4}
                    markerWidth={6}
                    markerHeight={6}
                    orient="auto"
                  >
                    <path d="M0 0 L8 4 L0 8 z" className="fill-text-secondary" />
                  </marker>
                </defs>
                {rows.map((r, i) => {
                  if (r.dependsOn === undefined) return null;
                  const from = rows[r.dependsOn];
                  if (!from) return null;
                  const x1 = (from.end + 1) * dayWidth;
                  const y1 = r.dependsOn * rowH + rowH / 2;
                  const x2 = r.start * dayWidth;
                  const y2 = i * rowH + rowH / 2;
                  const sx = Math.min(x1 - 8, x2 - 4);
                  return (
                    <path
                      key={r.key}
                      d={`M${sx} ${y1 + 10} V${y2} H${x2 - 2}`}
                      className="fill-none stroke-text-secondary"
                      strokeWidth={1.25}
                      markerEnd={`url(#${markerId})`}
                    />
                  );
                })}
              </svg>
            </div>
          </div>
        </ScrollRegion>
      </div>
    </figure>
  );
}

/** People against days with their shifts; double bookings are flagged in place. A native table. */
export function ResourceSchedule({ label, days, people }: ResourceScheduleProps): ReactElement {
  const t = useT();
  return (
    <ScrollRegion label={label}>
      <table className="w-full border-collapse text-text-13">
        <caption className="pb-8 text-start font-semibold">{label}</caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="h-control-lg px-12 text-start font-medium text-text-12 text-text-secondary bg-bg-surface border-b border-border-subtle"
            >
              {t("resource.person")}
            </th>
            {days.map((d) => (
              <th
                key={d.key}
                scope="col"
                className={cx(
                  "h-control-lg px-12 text-start font-medium text-text-12 border-b border-border-subtle",
                  d.weekend ? "bg-bg-surface" : "bg-bg-surface",
                )}
              >
                <span className="text-text-secondary">{d.dow}</span>{" "}
                <span className="tabular-nums">{d.date}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {people.map((p) => (
            <tr key={p.name}>
              <th
                scope="row"
                className="px-12 py-6 text-start font-regular border-b border-border-subtle"
              >
                <span className="flex items-center gap-8 whitespace-nowrap">
                  <Avatar name={p.name} />
                  <span className="flex flex-col">
                    <span>{p.name}</span>
                    <span className="text-text-secondary">{p.role}</span>
                  </span>
                </span>
              </th>
              {days.map((d) => {
                const shifts = (p.shifts ?? []).filter((s) => s.day === d.key);
                const clash = shifts.length > 1;
                return (
                  <td
                    key={d.key}
                    className={cx(
                      "min-w-(--space-64) px-12 py-6 align-top border-b border-border-subtle",
                      d.weekend && "bg-bg-surface",
                      clash && "ring-(length:--stroke-width-focus) ring-inset ring-danger",
                    )}
                  >
                    {shifts.map((s, i) => (
                      <span
                        key={i}
                        className="flex items-center gap-4 mb-2 px-6 py-2 rounded-chip bg-bg-hover text-text-12"
                      >
                        <StateIcon state={s.state} size={12} />
                        <span className="tabular-nums">{s.time}</span>
                      </span>
                    ))}
                    {clash ? (
                      <span className="flex items-center gap-4 text-text-11 font-medium text-danger-text">
                        <Icon name="TriangleAlert" size={12} />
                        {t("resource.doubleBooked")}
                      </span>
                    ) : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}

function OrgNode({ node }: { node: OrgChartNode }) {
  const t = useT();
  const reports = node.reports ?? [];
  return (
    <li className="relative flex flex-col items-center">
      <div className="flex items-center gap-8 px-12 py-8 whitespace-nowrap rounded-card border border-border-subtle bg-bg-raised text-text-12">
        {node.name ? (
          <Avatar name={node.name} />
        ) : (
          <span
            aria-hidden="true"
            className="inline-grid place-items-center size-(--ui-avatar) rounded-full bg-bg-surface text-text-secondary"
          >
            <Icon name="UserPlus" size={12} />
          </span>
        )}
        <span className="flex flex-col">
          <strong className="font-semibold">{node.name ?? t("org.vacant")}</strong>
          <span className="text-text-secondary">{node.role}</span>
          {node.code ? <span className="font-mono text-text-secondary">{node.code}</span> : null}
        </span>
      </div>
      {reports.length ? (
        <ul className="relative flex justify-center gap-16 m-0 pt-20 p-0 list-none before:absolute before:top-0 before:start-1/2 before:h-(--space-12) before:border-s before:border-border-control">
          {reports.map((r) => (
            <OrgNode key={`${r.name ?? ""}-${r.role}`} node={r} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** Reporting lines as a nested list; vacant positions read Vacant rather than being hidden. */
export function OrgChart({ label, root }: OrgChartProps): ReactElement {
  return (
    <ScrollRegion label={label}>
      <div role="group" aria-label={label} className="w-max min-w-full">
        <ul className="flex justify-center m-0 p-0 list-none">
          <OrgNode node={root} />
        </ul>
      </div>
    </ScrollRegion>
  );
}
