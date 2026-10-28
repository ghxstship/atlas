import { useId, type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { StateIcon } from "../StateIcon/StateIcon.tsx";
import { ScrollRegion } from "../Layout/Layout.tsx";
import { type TimelineProps } from "./Charts.types.ts";

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
              <span className="truncate" title={r.title}>{r.title}</span>
            </div>
          ))}
        </div>
        {/* The day grid scrolls sideways; the region takes keyboard focus when it overflows, so
            arrow keys reach the later dates (2.1.1). Its drawing stays hidden: the table above
            carries the data. */}
        <ScrollRegion label={t("timeline.scroll", { label })} frameClassName="flex-1">
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
