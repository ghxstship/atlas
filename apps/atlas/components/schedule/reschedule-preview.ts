import type { RescheduleMove, TimelineModel } from "@xos/data/schedule";
import type { TimelineChange, TimelinePreview } from "@xos/ui";
import type { ActionResult } from "@/components/work/action-result";

/** The record a change is about and the whole days its start and end move. */
export function shiftsOf(
  bars: TimelineModel["bars"],
  change: TimelineChange,
): { recordId: string; startDays: number; endDays: number } | null {
  const bar = bars[change.row];
  return bar
    ? {
        recordId: bar.record.id,
        startDays: change.start - bar.start,
        endDays: change.end - bar.end,
      }
    : null;
}

/**
 * The server's answer for a change as the Timeline's preview: every record it moves that the view
 * draws, as the bar's new days, and a note counting the records it moves that the view leaves out.
 * A refusal comes back as the catalog sentence for its key, then the database's correction if any.
 */
export function previewOf(
  bars: TimelineModel["bars"],
  change: TimelineChange,
  result: ActionResult<RescheduleMove[]>,
  copy: { error: (key: string) => string; offView: (count: number) => string },
): TimelinePreview {
  if (!result.ok) {
    const { key, detail } = result.error;
    return {
      change,
      moves: [],
      refusal: detail ? `${copy.error(key)} ${detail}` : copy.error(key),
    };
  }
  const rowOf = new Map(bars.map((b, i) => [b.record.id, i]));
  const moves: TimelinePreview["moves"] = [];
  let offView = 0;
  for (const m of result.data) {
    if (m.isTarget) continue;
    const row = rowOf.get(m.recordId);
    const bar = row === undefined ? undefined : bars[row];
    if (row === undefined || !bar) {
      offView += 1;
      continue;
    }
    moves.push({ row, start: bar.start + m.shiftStartDays, end: bar.end + m.shiftEndDays });
  }
  return { change, moves, ...(offView > 0 ? { note: copy.offView(offView) } : {}) };
}

/**
 * Asks the server to preview the pending change once the pointer or keys have rested for
 * `delayMs`. Only the newest request may show its answer: an older one arriving late is dropped,
 * and so is any answer after `dispose` (the timeline refreshed, or the page left). A request that
 * throws shows `failure` for its change, so the Timeline never waits on it forever.
 */
export function createPreviewer(options: {
  readonly delayMs: number;
  readonly run: (change: TimelineChange) => Promise<TimelinePreview>;
  readonly show: (preview: TimelinePreview) => void;
  readonly failure: (change: TimelineChange) => TimelinePreview;
}): { request: (change: TimelineChange | null) => void; dispose: () => void } {
  let latest = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    latest += 1;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    request(change) {
      stop();
      if (!change) return;
      const ask = latest;
      timer = setTimeout(() => {
        timer = undefined;
        options.run(change).then(
          (preview) => {
            if (ask === latest) options.show(preview);
          },
          () => {
            if (ask === latest) options.show(options.failure(change));
          },
        );
      }, options.delayMs);
    },
    dispose: stop,
  };
}
