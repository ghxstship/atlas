"use client";

import type { BulkOutcome, BulkRow } from "@xos/data/bulk";
import type { Cue } from "@xos/data/show";
import { Button, Checkbox, InlineAlert, Input } from "@xos/ui";
import { undoStack, type UndoResult } from "@xos/ui/undo";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useCopy } from "@/components/work/action-ui";
import { bulkUpdateAction } from "@/lib/bulk/actions";

const LIMIT = 1440;

/** Minutes with their sign, +5 or -10, as the copy shows them. */
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

/**
 * Shift the planned times of cues still to come (Section 11.7, P8), loaded on demand by the run of
 * show's edit mode. Each uncalled cue with a planned time gets a checkbox, with one to select every
 * such cue at once; Preview asks app.bulk_update_cues how many move (a called cue keeps its time and
 * is refused, cue_called, so nothing changes), Apply moves them in one transaction, and Undo (the
 * toast or Cmd or Ctrl+Z) sets the old times back. Every step is announced in a live region.
 */
export function CueShift({
  org,
  runId,
  cues,
  label,
}: {
  org: string;
  runId: string;
  cues: readonly Cue[];
  /** The time each cue is planned for, as the list shows it. */
  label: (cue: Cue) => string;
}) {
  const t = useCopy("show");
  const router = useRouter();
  const open = cues.filter((c) => !c.calledAt && c.plannedAt);
  const called = cues.filter((c) => c.calledAt).length;
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [raw, setRaw] = useState("+5");
  const [preview, setPreview] = useState<BulkOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const [pending, start] = useTransition();

  const minutes = /^[+-]?\d{1,4}$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  const valid = Number.isInteger(minutes) && minutes !== 0 && Math.abs(minutes) <= LIMIT;
  const ids = open.filter((c) => picked.has(c.id)).map((c) => c.id);
  const allPicked = open.length > 0 && ids.length === open.length;

  const reset = () => {
    setPreview(null);
    setError(null);
  };
  const toggle = (id: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
    reset();
  };

  const send = async (rows: readonly BulkRow[]): Promise<UndoResult> => {
    const result = await bulkUpdateAction({
      org,
      resource: "cues",
      rows: rows.map((r) => ({
        id: r.id,
        set: { ...r.set },
        ...(r.expect ? { expect: { ...r.expect } } : {}),
      })),
      preview: false,
    });
    if (result.ok && result.outcome.committed) {
      router.refresh();
      setSaid(t("cueShift.undone"));
      return { ok: true };
    }
    const message = result.ok ? result.outcome.refused[0]?.message : result.message;
    return { ok: false, message: message ?? t("cueShift.failed") };
  };

  const run = (asPreview: boolean) =>
    start(async () => {
      const result = await bulkUpdateAction({
        org,
        resource: "cues",
        rows: ids.map((id) => ({ id, set: { shift_minutes: minutes } })),
        preview: asPreview,
      });
      if (!result.ok) {
        setError(result.message ?? t("cueShift.failed"));
        setSaid(result.message ?? t("cueShift.failed"));
        return;
      }
      setError(null);
      const outcome = result.outcome;
      if (asPreview || !outcome.committed) {
        setPreview(outcome);
        setSaid(
          outcome.refused.length > 0
            ? t("cueShift.refused", { count: outcome.refused.length })
            : t("cueShift.preview", { count: outcome.changed, minutes: signed(minutes), called }),
        );
        return;
      }
      const done = t("cueShift.done", { count: outcome.changed, minutes: signed(minutes) });
      setSaid(done);
      setPreview(null);
      setPicked(new Set());
      const inverse = outcome.inverse;
      const again = inverse.map((r) => ({ id: r.id, set: r.expect ?? {}, expect: r.set }));
      undoStack.push({ label: done, undo: () => send(inverse), redo: () => send(again) });
      router.refresh();
    });

  if (open.length === 0) return null;
  const blocked = preview !== null && preview.refused.length > 0;
  return (
    <section aria-labelledby={`cue-shift-${runId}`} className="flex flex-col gap-8">
      <h3 id={`cue-shift-${runId}`} className="m-0 text-label-13 font-semibold">
        {t("cueShift.title")}
      </h3>
      <fieldset className="m-0 flex flex-col gap-4 border-0 p-0">
        <legend className="sr-only">{t("cueShift.pick")}</legend>
        <Checkbox
          label={t("cueShift.all", { count: open.length })}
          checked={allPicked}
          onChange={(e) => {
            setPicked(e.currentTarget.checked ? new Set(open.map((c) => c.id)) : new Set());
            reset();
          }}
        />
        {open.map((c) => (
          <Checkbox
            key={c.id}
            label={t("cueShift.cue", { position: c.position, label: c.label, time: label(c) })}
            checked={picked.has(c.id)}
            onChange={(e) => toggle(c.id, e.currentTarget.checked)}
          />
        ))}
      </fieldset>
      <div className="flex flex-wrap items-end gap-8">
        <Input
          id={`cue-shift-minutes-${runId}`}
          label={t("cueShift.minutes")}
          help={t("cueShift.minutesHelp")}
          width={160}
          inputMode="numeric"
          value={raw}
          {...(raw.trim() !== "" && !valid ? { error: t("cueShift.invalid") } : {})}
          onChange={(e) => {
            setRaw(e.target.value);
            reset();
          }}
        />
        {preview && !blocked && preview.changed > 0 ? (
          <Button variant="primary" loading={pending} onClick={() => run(false)}>
            {t("cueShift.apply", { count: preview.changed })}
          </Button>
        ) : (
          <Button loading={pending} disabled={!valid || ids.length === 0} onClick={() => run(true)}>
            {t("cueShift.previewButton")}
          </Button>
        )}
      </div>
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      {preview && !blocked ? (
        <p className="m-0 text-text-13">
          {t("cueShift.preview", { count: preview.changed, minutes: signed(minutes), called })}
        </p>
      ) : null}
      {blocked ? (
        <InlineAlert
          tone="warning"
          title={t("cueShift.refused", { count: preview.refused.length })}
        >
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {preview.refused.map((r, i) => (
              <li key={r.id ?? i}>
                {(r.id ? cues.find((c) => c.id === r.id)?.label : undefined) ?? ""} {r.message}
              </li>
            ))}
          </ul>
        </InlineAlert>
      ) : null}
      <p aria-live="polite" className="sr-only">
        {said}
      </p>
    </section>
  );
}
