import { useId, useState, type ReactElement } from "react";
import { scaleBand, scaleLinear } from "@visx/scale";
import { BarRounded, LinePath } from "@visx/shape";
import { Group } from "@visx/group";
import { PatternLines } from "@visx/pattern";
import type { ChartProps as ReferenceChartProps } from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useFormat, useT } from "../lib/context.tsx";
import { SegmentedControl } from "../Navigation/Navigation.tsx";
import { ScrollRegion } from "../Layout/Layout.tsx";

/**
 * The data chart (bar, line, area and combinations) on visx. Its own module so that the
 * calendar, timeline and list views never load the chart library (A24-009).
 */

export type ChartProps = ReferenceChartProps;

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
