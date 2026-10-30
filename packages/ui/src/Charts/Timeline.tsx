import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
} from "react";
import { Direction } from "radix-ui";
import { cx } from "../lib/cx.ts";
import { useFormat, useT } from "../lib/context.tsx";
import { StateIcon } from "../StateIcon/StateIcon.tsx";
import { ScrollRegion } from "../Layout/Layout.tsx";
import { Button } from "../Button/Button.tsx";
import { type TimelineChange, type TimelineProps } from "./Charts.types.ts";
import { planChange, sameMoves, sameRows, withMoves, type TimelinePlan } from "./timeline-plan.ts";

const TL_BAR: Record<string, string> = {
  active: cx("bg-accent"),
  complete: cx("bg-success opacity-85"),
  blocked: cx("bg-bg-hover ring-(length:--ui-hairline-half) ring-inset ring-danger"),
};

/** What a pointer drag changes: the whole bar, or one of its ends. */
type DragMode = "move" | "start" | "end";

interface Drag {
  readonly row: number;
  readonly mode: DragMode;
  readonly x: number;
  readonly from: TimelineChange;
  readonly pointer: number;
}

/** Pointer travel, in pixels, before a press on a bar becomes a drag. */
const DRAG_SLOP = 4;

/**
 * The Gantt view: bars by state, baselines, dependencies, gate markers, today and the critical path.
 * The drawing is hidden from assistive technology; a table beside it carries every row.
 *
 * With `onReschedule`, bars move and resize (Section 11.11). Dragging a bar moves it and dragging an
 * end resizes it; with a bar focused, arrow keys move it a day, Shift with an arrow moves its end,
 * Enter applies and Escape cancels. While a change is pending, the successors it pushes along
 * `links` show where they would land, a preview line says what moves and whether the critical path
 * changes, and a live region reads the same line. Apply takes the second interaction. With
 * `awaitPreview`, Apply and Enter wait for the page's own preview of the exact change.
 */
export function Timeline({
  label,
  days,
  rows,
  gates = [],
  today,
  dayWidth = 32,
  links = [],
  onReschedule,
  onPendingChange,
  preview = null,
  awaitPreview = false,
}: TimelineProps): ReactElement {
  const t = useT();
  const format = useFormat();
  const dir = Direction.useDirection();
  const uid = useId().replace(/:/g, "");
  const markerId = `${uid}-arrow`;
  const rowH = 36;
  const width = days.length * dayWidth;
  const height = rows.length * rowH;
  const editable = onReschedule !== undefined;
  const [draft, setDraft] = useState<TimelineChange | null>(null);
  const [applying, setApplying] = useState(false);
  // What the live region last said about a change that is no longer pending (applied, canceled).
  const [notice, setNotice] = useState("");
  const drag = useRef<Drag | null>(null);
  const dragged = useRef(false);
  const pending = useRef(onPendingChange);
  useEffect(() => {
    pending.current = onPendingChange;
  });

  const dayLabel = (i: number) => {
    const d = days[i];
    return d ? (d.label ?? `${d.dow} ${d.date}`) : "";
  };
  const spans = useMemo(
    () =>
      rows.map((r) => ({ start: r.start, end: r.end, ...(r.milestone ? { point: true } : {}) })),
    [rows],
  );
  const page =
    draft &&
    preview &&
    preview.change.row === draft.row &&
    preview.change.start === draft.start &&
    preview.change.end === draft.end
      ? preview
      : null;
  const isLocked = useMemo(() => (i: number) => rows[i]?.locked === true, [rows]);
  // The estimate from `links`; the page's own preview replaces it once it matches the change.
  const estimate: TimelinePlan | null = useMemo(
    () => (draft ? planChange(spans, links, draft, isLocked) : null),
    [draft, spans, links, isLocked],
  );
  const plan: TimelinePlan | null = useMemo(
    () => (draft && page ? withMoves(spans, links, draft, page.moves, isLocked) : estimate),
    [draft, page, spans, links, isLocked, estimate],
  );
  const cycle = draft !== null && plan === null;
  const refusal = page?.refusal ?? null;
  // The page's answer for this exact change has not arrived yet, so the estimate stands in for it.
  const waiting = awaitPreview && draft !== null && page === null && !cycle;
  const blocked = cycle || waiting || refusal !== null || (plan?.locked.length ?? 0) > 0;

  useEffect(() => {
    pending.current?.(draft);
  }, [draft]);

  /** Where each row sits now: the pending change and what it pushes, else where it is. */
  const at = (i: number): { start: number; end: number } => {
    if (draft && draft.row === i) return draft;
    const move = plan?.moves.find((m) => m.row === i);
    return move ?? rows[i] ?? { start: 0, end: 0 };
  };
  const moved = (i: number) => {
    const r = rows[i];
    const now = at(i);
    return !!r && (now.start !== r.start || now.end !== r.end);
  };
  const criticalNow = (i: number) =>
    plan ? plan.criticalAfter.includes(i) : rows[i]?.critical === true;

  const summary = (() => {
    if (!draft) return "";
    const row = rows[draft.row];
    if (!row) return "";
    const keys = (list: readonly number[]) =>
      format.list(list.flatMap((i) => (rows[i] ? [rows[i].key] : [])));
    const parts = [
      t("timeline.preview.change", {
        key: row.key,
        start: dayLabel(draft.start),
        end: dayLabel(draft.end),
      }),
    ];
    if (cycle) return [...parts, t("timeline.preview.cycle")].join(" ");
    if (plan) {
      const count = plan.moves.length;
      parts.push(
        count === 0
          ? t("timeline.preview.movesNone")
          : t(count === 1 ? "timeline.preview.movesOne" : "timeline.preview.movesMany", {
              count,
              keys: keys(plan.moves.map((m) => m.row)),
            }),
      );
      parts.push(
        t(
          sameRows(plan.criticalBefore, plan.criticalAfter)
            ? "timeline.preview.criticalSame"
            : "timeline.preview.criticalChanges",
        ),
      );
      const shift = plan.finishShift;
      if (shift !== 0) {
        const n = Math.abs(shift);
        const later = shift > 0 ? "Later" : "Earlier";
        parts.push(t(`timeline.preview.finish${later}${n === 1 ? "One" : "Many"}`, { count: n }));
      }
      if (plan.locked.length > 0) {
        parts.push(t("timeline.preview.locked", { keys: keys(plan.locked) }));
      }
    }
    if (page?.note) parts.push(page.note);
    if (refusal) parts.push(refusal);
    if (waiting) parts.push(t("timeline.preview.checking"));
    return parts.join(" ");
  })();

  const lastDay = Math.max(0, days.length - 1);
  const shifted = (from: TimelineChange, mode: DragMode, by: number): TimelineChange => {
    if (mode === "move") {
      const d = Math.max(-from.start, Math.min(lastDay - from.end, by));
      return { row: from.row, start: from.start + d, end: from.end + d };
    }
    if (mode === "end") {
      return { ...from, end: Math.max(from.start, Math.min(lastDay, from.end + by)) };
    }
    return { ...from, start: Math.min(from.end, Math.max(0, from.start + by)) };
  };
  const base = (i: number): TimelineChange => {
    if (draft && draft.row === i) return draft;
    const r = rows[i];
    return { row: i, start: r?.start ?? 0, end: r?.end ?? 0 };
  };
  const propose = (next: TimelineChange) => {
    const r = rows[next.row];
    setDraft(r && r.start === next.start && r.end === next.end ? null : next);
  };
  const cancel = () => {
    if (!draft) return;
    setDraft(null);
    setNotice(t("timeline.preview.canceled"));
  };
  // Apply or Enter pressed while the page's preview is on its way: applied when it arrives, if it
  // moves the same rows the estimate showed; otherwise its answer stays up to be applied again.
  const [queued, setQueued] = useState<TimelineChange | null>(null);
  const apply = async () => {
    if (!draft || !onReschedule || applying) return;
    if (waiting) {
      setQueued(draft);
      return;
    }
    if (blocked) return;
    const change = draft;
    const key = rows[change.row]?.key ?? "";
    setApplying(true);
    try {
      const result = await onReschedule(change);
      if (result !== false) {
        setDraft((d) => (d === change ? null : d));
        setNotice(t("timeline.preview.applied", { key }));
      }
    } finally {
      setApplying(false);
    }
  };

  useEffect(() => {
    if (!queued || waiting) return;
    setQueued(null);
    if (queued !== draft || blocked || !page || page.note || !estimate) return;
    if (sameMoves(estimate.moves, page.moves)) void apply();
    // apply reads this render's draft and preview, which are the ones checked here.
  }, [queued, waiting, draft, blocked, page, estimate]);

  const sign = dir === "rtl" ? -1 : 1;
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const step = event.key === "ArrowRight" ? sign : event.key === "ArrowLeft" ? -sign : 0;
    if (step !== 0) {
      event.preventDefault();
      propose(shifted(base(i), event.shiftKey && !rows[i]?.milestone ? "end" : "move", step));
      event.currentTarget.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    } else if (event.key === "Enter" && draft?.row === i) {
      event.preventDefault();
      void apply();
    } else if (event.key === "Escape" && draft) {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  };
  const onPointerDown = (event: PointerEvent<HTMLElement>, i: number, mode: DragMode) => {
    if (event.button > 0) return;
    event.stopPropagation();
    if (draft && draft.row !== i) setDraft(null);
    drag.current = {
      row: i,
      mode,
      x: event.clientX,
      from: draft && draft.row === i ? draft : base(i),
      pointer: event.pointerId,
    };
    dragged.current = false;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== event.pointerId) return;
    const dx = event.clientX - d.x;
    if (!dragged.current && Math.abs(dx) < DRAG_SLOP) return;
    dragged.current = true;
    propose(shifted(d.from, d.mode, Math.round((dx * sign) / dayWidth)));
  };
  const onPointerEnd = (event: PointerEvent<HTMLElement>) => {
    if (drag.current?.pointer !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const barBox = (i: number) => {
    const p = at(i);
    return {
      insetInlineStart: p.start * dayWidth + 2,
      inlineSize: (p.end - p.start + 1) * dayWidth - 4,
      insetBlockStart: i * rowH + 8,
    };
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
                {editable && r.locked ? ` (${t("timeline.locked")})` : ""}
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
            carries the data, and the bar controls laid over it carry rescheduling. */}
        <ScrollRegion label={t("timeline.scroll", { label })} frameClassName="flex-1">
          {/* Without rescheduling the whole content is the hidden drawing; with it, the drawing is
              hidden and the bar controls beside it are not. */}
          <div
            className="relative"
            style={{ inlineSize: width }}
            {...(editable ? {} : { "aria-hidden": true })}
          >
            <div {...(editable ? { "aria-hidden": true } : {})}>
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
                  const p = at(i);
                  const isMoved = moved(i);
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
                      {isMoved && !r.milestone ? (
                        // Where the bar was before the pending change.
                        <div
                          className="absolute h-(--space-20) rounded-chip border border-dashed border-border-strong"
                          style={{
                            insetInlineStart: r.start * dayWidth + 2,
                            inlineSize: (r.end - r.start + 1) * dayWidth - 4,
                            insetBlockStart: top + 8,
                          }}
                        />
                      ) : null}
                      {r.milestone ? (
                        <div
                          className={cx(
                            "absolute size-(--space-12) rotate-45 rounded-mark bg-warning",
                            isMoved && "ring-(length:--stroke-width-focus) ring-accent",
                          )}
                          style={{
                            insetInlineStart: p.start * dayWidth + dayWidth / 2 - 6,
                            insetBlockStart: top + 12,
                          }}
                        />
                      ) : (
                        <div
                          className={cx(
                            "absolute h-(--space-20) overflow-hidden rounded-chip",
                            TL_BAR[r.state] ??
                              "bg-bg-hover ring-(length:--stroke-width-hairline) ring-inset ring-border-strong",
                            criticalNow(i) &&
                              "ring-(length:--stroke-width-focus) ring-inset ring-danger",
                            isMoved &&
                              (r.locked
                                ? "outline-(length:--stroke-width-focus) outline-dashed outline-danger"
                                : "outline-(length:--stroke-width-focus) outline-dashed outline-accent"),
                            "forced-colors:bg-[Highlight]",
                          )}
                          style={barBox(i)}
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
                    if (!rows[r.dependsOn]) return null;
                    const x1 = (at(r.dependsOn).end + 1) * dayWidth;
                    const y1 = r.dependsOn * rowH + rowH / 2;
                    const x2 = at(i).start * dayWidth;
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
            {editable ? (
              <div
                role="group"
                aria-label={t("timeline.controls", { label })}
                className="absolute inset-x-0 bottom-0"
                style={{ blockSize: height }}
              >
                <span id={`${uid}-hint`} className="sr-only">
                  {t("timeline.moveHint")}
                </span>
                {rows.map((r, i) =>
                  r.locked ? null : (
                    <button
                      key={r.key}
                      type="button"
                      data-row={r.key}
                      aria-label={t("timeline.bar", {
                        key: r.key,
                        title: r.title,
                        start: dayLabel(at(i).start),
                        end: dayLabel(at(i).end),
                      })}
                      aria-describedby={`${uid}-hint`}
                      className={cx(
                        "absolute h-(--space-20) p-0 rounded-chip border-0 bg-transparent cursor-grab touch-none",
                        "active:cursor-grabbing",
                      )}
                      style={
                        r.milestone
                          ? {
                              insetInlineStart: at(i).start * dayWidth + dayWidth / 2 - 10,
                              inlineSize: 20,
                              insetBlockStart: i * rowH + 8,
                            }
                          : barBox(i)
                      }
                      onKeyDown={(e) => onKey(e, i)}
                      onPointerDown={(e) => onPointerDown(e, i, "move")}
                      onPointerMove={onPointerMove}
                      onPointerUp={onPointerEnd}
                      onPointerCancel={onPointerEnd}
                    >
                      {r.milestone ? null : (
                        <>
                          <span
                            aria-hidden="true"
                            className="absolute inset-y-0 start-0 w-(--space-6) cursor-ew-resize"
                            onPointerDown={(e) => onPointerDown(e, i, "start")}
                            onPointerMove={onPointerMove}
                            onPointerUp={onPointerEnd}
                            onPointerCancel={onPointerEnd}
                          />
                          <span
                            aria-hidden="true"
                            className="absolute inset-y-0 end-0 w-(--space-6) cursor-ew-resize"
                            onPointerDown={(e) => onPointerDown(e, i, "end")}
                            onPointerMove={onPointerMove}
                            onPointerUp={onPointerEnd}
                            onPointerCancel={onPointerEnd}
                          />
                        </>
                      )}
                    </button>
                  ),
                )}
              </div>
            ) : null}
          </div>
        </ScrollRegion>
      </div>
      {editable && draft ? (
        <div
          role="group"
          aria-label={t("timeline.preview.label")}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              cancel();
            }
          }}
          className="flex flex-wrap items-center gap-8 mt-8 px-12 py-8 rounded-card border border-border-subtle bg-bg-surface"
        >
          <p className="m-0 flex-1 min-w-0 text-text-13">{summary}</p>
          <Button
            size="sm"
            variant="primary"
            disabled={blocked && !waiting}
            loading={applying || (queued !== null && queued === draft)}
            onClick={() => void apply()}
          >
            {t("timeline.preview.apply")}
          </Button>
          <Button size="sm" variant="ghost" onClick={cancel}>
            {t("timeline.preview.cancel")}
          </Button>
        </div>
      ) : null}
      {editable ? (
        <p aria-live="polite" className="sr-only">
          {draft ? summary : notice}
        </p>
      ) : null}
    </figure>
  );
}
