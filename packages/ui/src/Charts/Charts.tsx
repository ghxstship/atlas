import {
  Children,
  isValidElement,
  useId,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import { scaleBand, scaleLinear } from "@visx/scale";
import { BarRounded, LinePath } from "@visx/shape";
import { Group } from "@visx/group";
import { PatternLines } from "@visx/pattern";
import type {
  CalendarProps as ReferenceCalendarProps,
  ChartProps as ReferenceChartProps,
  GalleryProps as ReferenceGalleryProps,
  OrgChartNode,
  OrgChartProps as ReferenceOrgChartProps,
  ResourceScheduleProps as ReferenceResourceScheduleProps,
  TimelineProps as ReferenceTimelineProps,
} from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useFormat, useLocale, useT } from "../lib/context.tsx";
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
export type ChartProps = ReferenceChartProps;
export interface SparklineProps {
  values: (number | null)[];
  /** Decorative unless labeled; the tile states the figure in text. */
  label?: string;
}

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
      className="flex items-center gap-4 w-full px-4 py-2 rounded-chip border-0 bg-bg-hover text-start text-text-12 truncate cursor-pointer"
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
                        "h-(--space-64) p-4 align-top border-e border-b border-border-subtle text-text-12",
                        d === null && "bg-bg-surface",
                      )}
                    >
                      {d !== null ? (
                        <div className="flex flex-col gap-2">
                          <span
                            aria-current={iso === today ? "date" : undefined}
                            className={cx(
                              "self-start px-4 py-2 rounded-chip text-text-11 text-text-secondary tabular-nums",
                              iso === today && "bg-accent text-accent-text-on font-semibold",
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
      <div
        aria-hidden="true"
        className="flex overflow-hidden rounded-card border border-border-subtle bg-bg-canvas"
      >
        <div className="flex-none w-(--ui-tree) max-sm:w-(--ui-skeleton-inline) bg-bg-surface border-e border-border-subtle">
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
        <div className="flex-1 overflow-x-auto">
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

const SERIES_FILL = [
  cx("fill-viz-cat-1"),
  cx("fill-viz-cat-2"),
  cx("fill-viz-cat-3"),
  cx("fill-viz-cat-4"),
  cx("fill-viz-cat-5"),
  cx("fill-viz-cat-6"),
  cx("fill-viz-cat-7"),
];
const SERIES_STROKE = [
  cx("stroke-viz-cat-1"),
  cx("stroke-viz-cat-2"),
  cx("stroke-viz-cat-3"),
  cx("stroke-viz-cat-4"),
  cx("stroke-viz-cat-5"),
  cx("stroke-viz-cat-6"),
  cx("stroke-viz-cat-7"),
];
const SERIES_VAR = [
  "--color-viz-cat-1",
  "--color-viz-cat-2",
  "--color-viz-cat-3",
  "--color-viz-cat-4",
  "--color-viz-cat-5",
  "--color-viz-cat-6",
  "--color-viz-cat-7",
];
const MARKERS = [
  "circle",
  "square",
  "triangle",
  "diamond",
  "cross",
  "circle-open",
  "square-open",
] as const;

interface Series {
  name: string;
  values: (number | null)[];
  other?: boolean;
}

/** Seven categorical colors at most: from the eighth series on, the sixth and later fold into one Other series, blank where any part is blank. */
export function foldSeries(
  series: ChartProps["series"],
  otherLabel: string,
  count: number,
): Series[] {
  if (series.length <= 7) return series;
  const rest = series.slice(6);
  return [
    ...series.slice(0, 6),
    {
      name: otherLabel,
      other: true,
      values: Array.from({ length: count }, (_, i) => {
        let sum = 0;
        for (const s of rest) {
          const v = s.values[i];
          if (v === null || v === undefined) return null;
          sum += v;
        }
        return sum;
      }),
    },
  ];
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const e = 10 ** Math.floor(Math.log10(v));
  const f = v / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
}

function Marker({
  kind,
  x,
  y,
  className,
}: {
  kind: (typeof MARKERS)[number];
  x: number;
  y: number;
  className: string;
}) {
  const r = 4.5;
  switch (kind) {
    case "square":
      return <rect x={x - r} y={y - r} width={r * 2} height={r * 2} rx={1} className={className} />;
    case "triangle":
      return (
        <path
          d={`M${x} ${y - r - 1} L${x + r + 1} ${y + r} L${x - r - 1} ${y + r} Z`}
          className={className}
        />
      );
    case "diamond":
      return (
        <path
          d={`M${x} ${y - r - 1} L${x + r + 1} ${y} L${x} ${y + r + 1} L${x - r - 1} ${y} Z`}
          className={className}
        />
      );
    case "cross":
      return (
        <path
          d={`M${x - r} ${y} H${x + r} M${x} ${y - r} V${y + r}`}
          className={cx(className, "fill-none")}
          strokeWidth={2.5}
        />
      );
    case "circle-open":
      return (
        <circle cx={x} cy={y} r={r} className={cx(className, "fill-bg-canvas")} strokeWidth={2} />
      );
    case "square-open":
      return (
        <rect
          x={x - r}
          y={y - r}
          width={r * 2}
          height={r * 2}
          rx={1}
          className={cx(className, "fill-bg-canvas")}
          strokeWidth={2}
        />
      );
    default:
      return <circle cx={x} cy={y} r={r} className={className} />;
  }
}

/**
 * Bar and line charts on Visx with one y-axis, a legend for two or more series and a table view one
 * click away. Every series differs by a second encoding (texture or marker); missing values are gaps.
 */
export function Chart({
  type,
  title,
  subtitle,
  categoryLabel,
  categories,
  series: given,
  format = "number",
  currency,
  width = 640,
  height = 260,
}: ChartProps): ReactElement {
  const t = useT();
  const fmt = useFormat();
  const uid = useId().replace(/:/g, "");
  const [view, setView] = useState("chart");
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    s: string;
    c: string;
    v: number;
  } | null>(null);
  const series = foldSeries(given, t("chart.other"), categories.length);
  const fill = (s: Series, i: number) => (s.other ? cx("fill-viz-other") : (SERIES_FILL[i] ?? ""));
  const stroke = (s: Series, i: number) =>
    s.other ? cx("stroke-viz-other") : (SERIES_STROKE[i] ?? "");
  const colorVar = (s: Series, i: number) =>
    `var(${s.other ? "--color-viz-other" : (SERIES_VAR[i] ?? "--color-viz-other")})`;
  const value = (v: number) => (format === "money" ? fmt.currency(v, currency) : fmt.number(v));
  const pl = 60;
  const pr = type === "line" && series.length <= 4 ? 96 : 16;
  const pt = 12;
  const pb = 32;
  const innerW = width - pl - pr;
  const innerH = height - pt - pb;
  const all = series.flatMap((s) =>
    s.values.filter((v): v is number => v !== null && v !== undefined),
  );
  const max = niceMax(Math.max(0, ...all));
  const x = scaleBand({ domain: categories, range: [0, innerW], padding: 0.3 });
  const y = scaleLinear({ domain: [0, max], range: [innerH, 0] });
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const band = x.bandwidth();
  const gap = 2;
  const barW = Math.min(28, (band - gap * (series.length - 1)) / series.length);

  const table = (
    <ScrollRegion label={title}>
      <table className="w-full border-collapse text-text-13">
        <caption className="sr-only">{title}</caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="h-control-lg px-12 text-start font-medium text-text-12 text-text-secondary bg-bg-surface border-b border-border-subtle"
            >
              {categoryLabel}
            </th>
            {series.map((s) => (
              <th
                key={s.name}
                scope="col"
                className="h-control-lg px-12 text-end font-medium text-text-12 text-text-secondary bg-bg-surface border-b border-border-subtle"
              >
                {s.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {categories.map((c, ci) => (
            <tr key={c}>
              <th
                scope="row"
                className="h-row-default px-12 text-start font-regular border-b border-border-subtle"
              >
                {c}
              </th>
              {series.map((s) => {
                const v = s.values[ci];
                return (
                  <td
                    key={s.name}
                    className="h-row-default px-12 text-end border-b border-border-subtle tabular-nums"
                  >
                    {v === null || v === undefined ? (
                      <span className="text-text-secondary">{t("chart.noValue")}</span>
                    ) : (
                      value(v)
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );

  return (
    <figure className="flex flex-col gap-12 m-0 max-w-(--layout-reading)">
      <div className="flex flex-wrap items-start justify-between gap-12">
        <figcaption className="flex flex-col">
          <strong id={`${uid}-title`} className="font-semibold">
            {title}
          </strong>
          <span id={`${uid}-hint`} className="sr-only">
            {t("chart.tableHint")}
          </span>
          {subtitle ? <span className="text-text-secondary">{subtitle}</span> : null}
        </figcaption>
        <SegmentedControl
          label={t("chart.view")}
          value={view}
          onChange={setView}
          options={[
            { value: "chart", label: t("chart.chart"), icon: "ChartColumn" },
            { value: "table", label: t("chart.table"), icon: "Table" },
          ]}
        />
      </div>
      {series.length > 1 ? (
        <ul
          aria-label={t("chart.legend")}
          className="flex flex-wrap gap-x-16 gap-y-4 m-0 p-0 list-none text-text-12 text-text-secondary"
        >
          {series.map((s, si) => (
            <li key={s.name} className="flex items-center gap-6">
              <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden="true">
                {type === "line" ? (
                  <Marker
                    kind={MARKERS[si] ?? "circle"}
                    x={7}
                    y={7}
                    className={cx(fill(s, si), stroke(s, si))}
                  />
                ) : (
                  <rect
                    x={1}
                    y={1}
                    width={12}
                    height={12}
                    rx={3}
                    className={cx(fill(s, si), si % 2 ? "opacity-50" : undefined)}
                  />
                )}
              </svg>
              {s.name}
            </li>
          ))}
        </ul>
      ) : null}
      {view === "table" ? (
        table
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            width="100%"
            role="group"
            aria-labelledby={`${uid}-title ${uid}-hint`}
          >
            <defs>
              {series.map((s, si) =>
                si % 2 ? (
                  <PatternLines
                    key={s.name}
                    id={`${uid}-tex-${si}`}
                    width={6}
                    height={6}
                    stroke={colorVar(s, si)}
                    strokeWidth={2.5}
                    orientation={["diagonal"]}
                    background="transparent"
                  />
                ) : null,
              )}
            </defs>
            <Group left={pl} top={pt}>
              {ticks.map((tv) => (
                <g key={tv}>
                  <line
                    x1={0}
                    x2={innerW}
                    y1={y(tv)}
                    y2={y(tv)}
                    className={tv === 0 ? "stroke-border-control" : "stroke-border-subtle"}
                  />
                  <text
                    x={-8}
                    y={y(tv) + 4}
                    textAnchor="end"
                    className="fill-text-secondary text-text-11 tabular-nums"
                  >
                    {fmt.compact(tv, format === "money" ? (currency ?? "USD") : undefined)}
                  </text>
                </g>
              ))}
              {categories.map((c) => (
                <text
                  key={c}
                  x={(x(c) ?? 0) + band / 2}
                  y={innerH + 22}
                  textAnchor="middle"
                  className="fill-text-secondary text-text-11"
                >
                  {c}
                </text>
              ))}
              {type === "line"
                ? series.map((s, si) => {
                    const pts = s.values
                      .map((v, i) => ({ v, i }))
                      .filter(
                        (p): p is { v: number; i: number } => p.v !== null && p.v !== undefined,
                      );
                    const cls = cx(fill(s, si), stroke(s, si));
                    return (
                      <g key={s.name}>
                        <LinePath
                          data={s.values.map((v, i) => ({ v, i }))}
                          x={(p) => (x(categories[p.i] ?? "") ?? 0) + band / 2}
                          y={(p) => y(p.v ?? 0)}
                          defined={(p) => p.v !== null && p.v !== undefined}
                          className={cx("fill-none", stroke(s, si))}
                          strokeWidth={2}
                          strokeLinejoin="round"
                          strokeLinecap="round"
                          strokeDasharray={si % 2 ? "6 4" : undefined}
                        />
                        {pts.map((p) => {
                          const cx0 = (x(categories[p.i] ?? "") ?? 0) + band / 2;
                          const cy0 = y(p.v);
                          const show = () =>
                            setHover({
                              x: cx0 + pl,
                              y: cy0 + pt,
                              s: s.name,
                              c: categories[p.i] ?? "",
                              v: p.v,
                            });
                          return (
                            <g
                              key={p.i}
                              role="img"
                              tabIndex={0}
                              aria-label={t("chart.point", {
                                series: s.name,
                                category: categories[p.i] ?? "",
                                value: value(p.v),
                              })}
                              onMouseEnter={show}
                              onFocus={show}
                              onMouseLeave={() => setHover(null)}
                              onBlur={() => setHover(null)}
                              className="outline-none focus-visible:[&>circle:last-child]:stroke-focus-ring"
                            >
                              <Marker
                                kind={MARKERS[si] ?? "circle"}
                                x={cx0}
                                y={cy0}
                                className={cls}
                              />
                              <circle
                                cx={cx0}
                                cy={cy0}
                                r={12}
                                className="fill-transparent"
                                strokeWidth={2}
                              />
                            </g>
                          );
                        })}
                        {pr > 16 && pts.length ? (
                          <text
                            x={
                              (x(categories[pts[pts.length - 1]?.i ?? 0] ?? "") ?? 0) +
                              band / 2 +
                              10
                            }
                            y={y(pts[pts.length - 1]?.v ?? 0) + 4}
                            className="fill-text-primary text-text-11 font-medium"
                          >
                            {s.name}
                          </text>
                        ) : null}
                      </g>
                    );
                  })
                : series.map((s, si) => (
                    <g key={s.name}>
                      {s.values.map((v, i) => {
                        if (v === null || v === undefined) return null;
                        const bx =
                          (x(categories[i] ?? "") ?? 0) +
                          (band - (barW * series.length + gap * (series.length - 1))) / 2 +
                          si * (barW + gap);
                        const top = y(v);
                        const h = innerH - top;
                        const show = () =>
                          setHover({
                            x: bx + barW / 2 + pl,
                            y: top + pt,
                            s: s.name,
                            c: categories[i] ?? "",
                            v,
                          });
                        return (
                          <g
                            key={i}
                            role="img"
                            tabIndex={0}
                            aria-label={t("chart.point", {
                              series: s.name,
                              category: categories[i] ?? "",
                              value: value(v),
                            })}
                            onMouseEnter={show}
                            onFocus={show}
                            onMouseLeave={() => setHover(null)}
                            onBlur={() => setHover(null)}
                            className="outline-none focus-visible:[&>rect]:stroke-focus-ring"
                          >
                            <BarRounded
                              x={bx}
                              y={top}
                              width={barW}
                              height={h}
                              radius={Math.min(4, h)}
                              top
                              className={cx(
                                fill(s, si),
                                si % 2 === 1 && stroke(s, si),
                                "hover:brightness-110",
                              )}
                              {...(si % 2
                                ? { fill: `url(#${uid}-tex-${si})`, strokeWidth: 1.5 }
                                : {})}
                            />
                            <rect
                              x={bx - 2}
                              y={0}
                              width={barW + 4}
                              height={innerH}
                              className="fill-transparent"
                              strokeWidth={2}
                            />
                          </g>
                        );
                      })}
                    </g>
                  ))}
            </Group>
          </svg>
          {hover ? (
            <div
              role="status"
              className="absolute z-tooltip flex flex-col px-8 py-6 whitespace-nowrap pointer-events-none rounded-control bg-bg-raised shadow-menu text-text-12 -translate-x-1/2 -translate-y-[calc(100%+var(--space-8))] rtl:translate-x-1/2"
              style={{
                insetInlineStart: `${(hover.x / width) * 100}%`,
                insetBlockStart: `${(hover.y / height) * 100}%`,
              }}
            >
              <strong className="font-semibold">{hover.s}</strong>
              <span className="text-text-secondary">{hover.c}</span>
              <span className="tabular-nums">{value(hover.v)}</span>
            </div>
          ) : null}
        </div>
      )}
    </figure>
  );
}

/** A small trend line for StatTile; decorative unless labeled. Gaps stay gaps. */
export function Sparkline({ values, label }: SparklineProps): ReactElement {
  const width = 96;
  const height = 24;
  const numbers = values.filter((v): v is number => v !== null);
  const min = Math.min(...numbers, 0);
  const max = Math.max(...numbers, 1);
  const x = scaleLinear({ domain: [0, Math.max(1, values.length - 1)], range: [1, width - 1] });
  const y = scaleLinear({ domain: [min, max], range: [height - 2, 2] });
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      <LinePath
        data={values.map((v, i) => ({ v, i }))}
        x={(p) => x(p.i)}
        y={(p) => y(p.v ?? 0)}
        defined={(p) => p.v !== null}
        className="fill-none stroke-accent"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
