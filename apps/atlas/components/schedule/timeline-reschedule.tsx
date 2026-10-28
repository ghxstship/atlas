"use client";

import type { TimelineModel } from "@xos/data/schedule";
import { Timeline, type TimelineChange, type TimelinePreview } from "@xos/ui";
import { useFormatter } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionError } from "@/components/work/action-result";
import { ActionErrorAlert, useCopy } from "@/components/work/action-ui";
import { rescheduleRecordAction } from "./actions";
import { timelineView } from "./timeline-view";

/** Quiet time after the last arrow key or pointer step before the server previews the change. */
const PREVIEW_DELAY_MS = 250;

/** The record a change is about and the whole days its start and end move. */
function shiftsOf(bars: TimelineModel["bars"], change: TimelineChange) {
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
 * Schedule > Timeline with drag to reschedule (Section 11.11, A133), for people who may change the
 * timeline. While a change is pending the bar shows the estimate the Timeline works out from the
 * drawn dependencies; once the pointer or keys rest, app.reschedule_record previews it on the server
 * (every dependency, locked records, records this view filters out) and that answer replaces the
 * estimate. Apply commits the same computation in one transaction, and the page refreshes with the
 * new dates. Loaded on demand with the timeline view, so other views never carry it (ADR 0027).
 */
export function RescheduleTimeline({
  org,
  label,
  timeline,
}: {
  org: string;
  label: string;
  timeline: TimelineModel;
}) {
  const format = useFormatter();
  const t = useCopy("schedule");
  const w = useCopy("work");
  const view = useMemo(() => timelineView(timeline, format), [timeline, format]);
  const rowOf = useMemo(
    () => new Map(timeline.bars.map((b, i) => [b.record.id, i])),
    [timeline.bars],
  );
  const [preview, setPreview] = useState<TimelinePreview | null>(null);
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, setPending] = useState<TimelineChange | null>(null);
  // Only the newest request may set the preview: an older answer arriving late is dropped.
  const latest = useRef(0);

  useEffect(() => {
    const ask = ++latest.current;
    if (!pending) return undefined;
    const input = shiftsOf(timeline.bars, pending);
    if (!input) return undefined;
    const timer = setTimeout(() => {
      void rescheduleRecordAction(org, { ...input, commit: false }).then((result) => {
        if (ask !== latest.current) return;
        if (!result.ok) {
          setPreview({ change: pending, moves: [], refusal: w(`errors.${result.error.key}`) });
          return;
        }
        const moves = [];
        let offView = 0;
        for (const m of result.data) {
          if (m.isTarget) continue;
          const row = rowOf.get(m.recordId);
          const bar = row === undefined ? undefined : timeline.bars[row];
          if (row === undefined || !bar) {
            offView += 1;
            continue;
          }
          moves.push({ row, start: bar.start + m.shiftStartDays, end: bar.end + m.shiftEndDays });
        }
        setPreview({
          change: pending,
          moves,
          ...(offView > 0 ? { note: t("reschedule.offView", { count: offView }) } : {}),
        });
      });
    }, PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [pending, org, rowOf, timeline.bars, t, w]);

  const apply = async (change: TimelineChange): Promise<boolean> => {
    const input = shiftsOf(timeline.bars, change);
    if (!input) return false;
    setError(null);
    const result = await rescheduleRecordAction(org, { ...input, commit: true });
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    return true;
  };

  return (
    <div className="flex flex-col gap-8">
      <ActionErrorAlert error={error} />
      <Timeline
        label={label}
        {...view}
        preview={preview}
        onPendingChange={(change) => {
          setPending(change);
          if (!change) setError(null);
        }}
        onReschedule={apply}
      />
    </div>
  );
}
