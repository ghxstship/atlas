"use client";

import type { BulkRow } from "@xos/data/bulk";
import { shiftUndoRows } from "@xos/data/schedule";
import { Button, Card, RECORD_MIME, Select } from "@xos/ui";
import { undoStack, type UndoResult } from "@xos/ui/undo";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { ActionError } from "@/components/work/action-result";
import { ActionErrorAlert, useCopy } from "@/components/work/action-ui";
import { bulkUpdateAction } from "@/lib/bulk/actions";
import { placeRecordAction, type MovePlan } from "./actions";

export interface BacklogItem {
  readonly id: string;
  /** "KEY Title". */
  readonly label: string;
}

export interface BacklogDay {
  /** YYYY-MM-DD on the project's calendar. */
  readonly day: string;
  /** The day named in full, as the timeline's table names it. */
  readonly label: string;
}

/** A placement the person is looking at: a record, a day and the server's preview of it. */
interface Pending {
  readonly item: BacklogItem;
  readonly day: string;
  readonly plan: MovePlan | null;
}

/**
 * The schedule's Unscheduled list (Section 11.11, P8): records with no dates, beside the
 * timeline. Each one can be dragged onto a day of the timeline (application/x-xos-record), or, by
 * keyboard, scheduled with its Schedule button: choose a day, read the preview (app.place_record:
 * 09:00 to 17:00 project time, a Milestone due at 17:00, and the successors it pushes), then Apply.
 * A drop opens the same preview for the day it landed on. Every placement is announced, and its
 * Undo sends the dates back to none through app.bulk_update_records, so the record returns here.
 * Loaded with the timeline reschedule view, never with the page.
 */
export function ScheduleBacklog({
  org,
  items,
  days,
  dropped,
  onDropHandled,
}: {
  org: string;
  items: readonly BacklogItem[];
  days: readonly BacklogDay[];
  /** A record dropped on the timeline, by id and day, for this list to preview. */
  dropped: { readonly id: string; readonly day: string } | null;
  onDropHandled: () => void;
}) {
  const t = useCopy("schedule");
  const router = useRouter();
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<ActionError | null>(null);
  const [said, setSaid] = useState("");
  const [busy, start] = useTransition();

  const dayLabel = (day: string) => days.find((d) => d.day === day)?.label ?? day;

  const preview = (item: BacklogItem, day: string) =>
    start(async () => {
      setError(null);
      setPending({ item, day, plan: null });
      const result = await placeRecordAction(org, { recordId: item.id, day, commit: false });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPending({ item, day, plan: result.data });
    });

  // A record dropped on the timeline opens its preview here.
  useEffect(() => {
    if (!dropped) return;
    const item = items.find((i) => i.id === dropped.id);
    onDropHandled();
    if (item) preview(item, dropped.day);
    // preview is recreated each render; the drop is handled once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropped]);

  const send = async (rows: readonly BulkRow[]): Promise<UndoResult> => {
    const result = await bulkUpdateAction({
      org,
      resource: "records",
      rows: rows.map((r) => ({
        id: r.id,
        set: { ...r.set },
        ...(r.expect ? { expect: { ...r.expect } } : {}),
      })),
      preview: false,
    });
    if (result.ok && result.outcome.committed) {
      router.refresh();
      return { ok: true };
    }
    const first = result.ok ? result.outcome.refused[0] : undefined;
    return { ok: false, message: first?.message ?? t("backlog.undoFailed") };
  };

  const apply = (p: Pending) =>
    start(async () => {
      const result = await placeRecordAction(org, {
        recordId: p.item.id,
        day: p.day,
        commit: true,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPending(null);
      setError(null);
      const announcement = t("backlog.placed", { record: p.item.label, day: dayLabel(p.day) });
      setSaid(announcement);
      const inverse = shiftUndoRows(result.data.moves);
      undoStack.push({
        label: announcement,
        undo: () => send(inverse),
        redo: async () => {
          const again = await placeRecordAction(org, {
            recordId: p.item.id,
            day: p.day,
            commit: true,
          });
          if (again.ok) {
            router.refresh();
            return { ok: true };
          }
          return { ok: false, message: t("backlog.undoFailed") };
        },
      });
      router.refresh();
    });

  const pushed = pending?.plan?.moves.filter((m) => !m.isTarget) ?? [];
  return (
    <Card>
      <section aria-labelledby="schedule-backlog-title" className="flex flex-col gap-8">
        <h2 id="schedule-backlog-title" className="m-0 text-text-14 font-semibold">
          {t("backlog.title", { count: items.length })}
        </h2>
        <p className="m-0 text-text-12 text-text-secondary">{t("backlog.help")}</p>
        {items.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("backlog.empty")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-4 p-0">
            {items.map((item) => (
              <li
                key={item.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(RECORD_MIME, item.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                className="flex items-center justify-between gap-8 rounded-control border border-border-subtle bg-bg-canvas px-8 py-4 text-text-13 cursor-grab"
              >
                <span className="min-w-0 truncate">{item.label}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("backlog.scheduleOne", { record: item.label })}
                  onClick={() => {
                    setError(null);
                    setPending({ item, day: days[0]?.day ?? "", plan: null });
                  }}
                >
                  {t("backlog.schedule")}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {pending ? (
          <div
            role="group"
            aria-label={t("backlog.placing", { record: pending.item.label })}
            className="flex flex-col gap-8 border-t border-border-subtle pt-8"
          >
            <Select
              id="schedule-backlog-day"
              label={t("backlog.day", { record: pending.item.label })}
              value={pending.day}
              options={days.map((d) => ({ value: d.day, label: d.label }))}
              onChange={(e) => setPending({ ...pending, day: e.target.value, plan: null })}
            />
            {pending.plan ? (
              <div role="status" className="flex flex-col gap-4 text-text-13">
                <p className="m-0">
                  {t("backlog.preview", {
                    record: pending.item.label,
                    day: dayLabel(pending.day),
                  })}
                </p>
                {pushed.length > 0 ? (
                  <>
                    <p className="m-0">{t("backlog.pushes", { count: pushed.length })}</p>
                    <ul className="m-0 flex list-disc flex-col gap-2 ps-20">
                      {pushed.map((m) => (
                        <li key={m.recordId}>{pending.plan?.labels[m.recordId] ?? m.recordId}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </div>
            ) : null}
            <ActionErrorAlert error={error} />
            <div className="flex gap-6">
              <Button variant="ghost" onClick={() => setPending(null)}>
                {t("backlog.cancel")}
              </Button>
              {pending.plan ? (
                <Button variant="primary" loading={busy} onClick={() => apply(pending)}>
                  {t("backlog.apply")}
                </Button>
              ) : (
                <Button
                  loading={busy}
                  disabled={!pending.day}
                  onClick={() => preview(pending.item, pending.day)}
                >
                  {t("backlog.previewButton")}
                </Button>
              )}
            </div>
          </div>
        ) : null}
        <p aria-live="polite" className="sr-only">
          {said}
        </p>
      </section>
    </Card>
  );
}
