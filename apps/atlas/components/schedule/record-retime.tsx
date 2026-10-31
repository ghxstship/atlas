"use client";

import type { BulkRow } from "@xos/data/bulk";
import { shiftUndoRows, type RescheduleMove } from "@xos/data/schedule";
import { Button, Input } from "@xos/ui";
import { undoStack, type UndoResult } from "@xos/ui/undo";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ActionError } from "@/components/work/action-result";
import { ActionErrorAlert, useCopy } from "@/components/work/action-ui";
import { bulkUpdateAction } from "@/lib/bulk/actions";
import { rescheduleRecordAction } from "./actions";

/** At most fourteen days either way, as app.reschedule_record allows (2850). */
const LIMIT = 20_160;

/** Signed hours and minutes, "+1:30", "-0:15" or "45", in minutes; null when it does not read. */
export function parseOffset(text: string): number | null {
  const value = text.trim();
  if (value === "") return 0;
  const clock = /^([+-])?(\d{1,3}):([0-5]\d)$/.exec(value);
  const plain = /^([+-])?(\d{1,5})$/.exec(value);
  const minutes = clock
    ? Number(clock[2]) * 60 + Number(clock[3])
    : plain
      ? Number(plain[2])
      : null;
  if (minutes === null) return null;
  const signed = (clock ?? plain)?.[1] === "-" ? -minutes : minutes;
  return Math.abs(signed) <= LIMIT ? signed : null;
}

/**
 * Minute retime of one dated record (Section 11.11, P8), loaded on demand from the record page for
 * people who may change the timeline. Move by shifts its start and end; Change length by moves its
 * end only, so the start moves by Move by and the end by Move by plus Change length. Preview asks
 * app.reschedule_record what moves (the record and every successor it pushes, by whole minutes),
 * Apply writes exactly that, and Undo sends the old times back through app.bulk_update_records.
 */
export function RecordRetime({ org, recordId }: { org: string; recordId: string }) {
  const t = useCopy("schedule");
  const router = useRouter();
  const [move, setMove] = useState("");
  const [length, setLength] = useState("");
  const [moves, setMoves] = useState<RescheduleMove[] | null>(null);
  const [error, setError] = useState<ActionError | null>(null);
  const [said, setSaid] = useState("");
  const [pending, start] = useTransition();

  const by = parseOffset(move);
  const longer = parseOffset(length);
  const valid = by !== null && longer !== null && (by !== 0 || longer !== 0);
  const startMinutes = by ?? 0;
  const endMinutes = (by ?? 0) + (longer ?? 0);

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
    return { ok: false, message: first?.message ?? t("retime.undoFailed") };
  };

  const run = (commit: boolean) =>
    start(async () => {
      const result = await rescheduleRecordAction(org, {
        recordId,
        startDays: 0,
        endDays: 0,
        startMinutes,
        endMinutes,
        commit,
      });
      if (!result.ok) {
        setError(result.error);
        setMoves(null);
        return;
      }
      setError(null);
      if (!commit) {
        setMoves(result.data);
        return;
      }
      const label = t("retime.done", { count: result.data.length });
      setSaid(label);
      setMoves(null);
      setMove("");
      setLength("");
      const inverse = shiftUndoRows(result.data);
      undoStack.push({ label, undo: () => send(inverse) });
      router.refresh();
    });

  const edit = (set: (v: string) => void) => (e: { target: { value: string } }) => {
    set(e.target.value);
    setMoves(null);
  };
  const pushed = moves?.filter((m) => !m.isTarget).length ?? 0;
  return (
    <section aria-labelledby={`retime-${recordId}`} className="flex flex-col gap-8">
      <h3 id={`retime-${recordId}`} className="m-0 text-label-13 font-semibold">
        {t("retime.title")}
      </h3>
      <div className="flex flex-wrap gap-12">
        <Input
          id={`retime-move-${recordId}`}
          label={t("retime.move")}
          help={t("retime.offsetHelp")}
          width={160}
          value={move}
          {...(by === null ? { error: t("retime.invalid") } : {})}
          onChange={edit(setMove)}
        />
        <Input
          id={`retime-length-${recordId}`}
          label={t("retime.length")}
          help={t("retime.offsetHelp")}
          width={160}
          value={length}
          {...(longer === null ? { error: t("retime.invalid") } : {})}
          onChange={edit(setLength)}
        />
      </div>
      {moves ? (
        <p role="status" className="m-0 text-text-13">
          {pushed > 0 ? t("retime.previewPushes", { count: pushed }) : t("retime.previewAlone")}
        </p>
      ) : null}
      <ActionErrorAlert error={error} />
      <div className="flex gap-6">
        {moves ? (
          <Button variant="primary" loading={pending} onClick={() => run(true)}>
            {t("retime.apply")}
          </Button>
        ) : (
          <Button loading={pending} disabled={!valid} onClick={() => run(false)}>
            {t("retime.preview")}
          </Button>
        )}
      </div>
      <p aria-live="polite" className="sr-only">
        {said}
      </p>
    </section>
  );
}
