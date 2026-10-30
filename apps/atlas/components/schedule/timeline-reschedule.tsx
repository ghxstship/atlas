"use client";

import type { TimelineModel } from "@xos/data/schedule";
import { Timeline, type TimelineChange, type TimelinePreview } from "@xos/ui";
import { useFormatter } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionError } from "@/components/work/action-result";
import { ActionErrorAlert, useCopy } from "@/components/work/action-ui";
import { rescheduleRecordAction } from "./actions";
import { createPreviewer, previewOf, shiftsOf } from "./reschedule-preview";
import { ScheduleBacklog, type BacklogItem } from "./schedule-backlog";
import { timelineView } from "./timeline-view";

/** Quiet time after the last arrow key or pointer step before the server previews the change. */
const PREVIEW_DELAY_MS = 250;

/**
 * Schedule > Timeline with drag to reschedule (Section 11.11, A133), for people who may change the
 * timeline. While a change is pending the bar shows the estimate the Timeline works out from the
 * drawn dependencies; once the pointer or keys rest, app.reschedule_record previews it on the server
 * (every dependency, locked records, records this view filters out) and that answer replaces the
 * estimate. Apply and Enter wait for that answer (`awaitPreview`), so what is applied is what the
 * server previewed; the commit runs the same computation in one transaction and the page refreshes
 * with the new dates. Beside it, the Unscheduled list (P8) holds the records with no dates, to be
 * dropped on a day or scheduled by keyboard. Loaded on demand with the timeline view, so other
 * views never carry it (ADR 0027).
 */
export function RescheduleTimeline({
  org,
  label,
  timeline,
  backlog = [],
}: {
  org: string;
  label: string;
  timeline: TimelineModel;
  backlog?: readonly BacklogItem[];
}) {
  const format = useFormatter();
  const t = useCopy("schedule");
  const w = useCopy("work");
  const view = useMemo(() => timelineView(timeline, format), [timeline, format]);
  // A preview belongs to the bars it was worked out on; after a refresh it no longer applies.
  const [answer, setAnswer] = useState<{
    bars: TimelineModel["bars"];
    preview: TimelinePreview;
  } | null>(null);
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, setPending] = useState<TimelineChange | null>(null);
  const [dropped, setDropped] = useState<{ id: string; day: string } | null>(null);

  // The copy is read when an answer arrives, so a new translator never restarts a preview.
  const copy = useRef({
    error: (key: string) => w(`errors.${key}`),
    offView: (count: number) => t("reschedule.offView", { count }),
  });
  useEffect(() => {
    copy.current = {
      error: (key: string) => w(`errors.${key}`),
      offView: (count: number) => t("reschedule.offView", { count }),
    };
  }, [t, w]);

  // One previewer per set of bars: a refresh drops whatever the old one still had on its way.
  const previewer = useRef<ReturnType<typeof createPreviewer> | null>(null);
  useEffect(() => {
    const bars = timeline.bars;
    const current = createPreviewer({
      delayMs: PREVIEW_DELAY_MS,
      run: async (change) => {
        const input = shiftsOf(bars, change);
        if (!input) return { change, moves: [], refusal: copy.current.error("unexpected") };
        const result = await rescheduleRecordAction(org, { ...input, commit: false });
        return previewOf(bars, change, result, copy.current);
      },
      show: (preview) => setAnswer({ bars, preview }),
      failure: (change) => ({ change, moves: [], refusal: copy.current.error("unexpected") }),
    });
    previewer.current = current;
    return () => {
      current.dispose();
      if (previewer.current === current) previewer.current = null;
    };
  }, [org, timeline.bars]);
  useEffect(() => {
    previewer.current?.request(pending);
  }, [pending, org, timeline.bars]);

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

  const drawn = (
    <Timeline
      label={label}
      {...view}
      preview={answer && answer.bars === timeline.bars ? answer.preview : null}
      awaitPreview
      onPendingChange={(change) => {
        setPending(change);
        if (!change) setError(null);
      }}
      onReschedule={apply}
      {...(backlog.length > 0
        ? {
            onDayDrop: (index: number, id: string) => {
              const day = timeline.days[index]?.day;
              if (day) setDropped({ id, day });
            },
          }
        : {})}
    />
  );

  return (
    <div className="flex flex-col gap-8">
      <ActionErrorAlert error={error} />
      {backlog.length > 0 ? (
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="min-w-0">{drawn}</div>
          <ScheduleBacklog
            org={org}
            items={backlog}
            days={timeline.days.map((d, i) => ({
              day: d.day,
              label: view.days[i]?.label ?? d.day,
            }))}
            dropped={dropped}
            onDropHandled={() => setDropped(null)}
          />
        </div>
      ) : (
        drawn
      )}
    </div>
  );
}
