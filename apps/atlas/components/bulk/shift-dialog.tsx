"use client";

import type { BulkRow } from "@xos/data/bulk";
import { shiftUndoRows, type ShiftMove } from "@xos/data/schedule";
import { Button, Dialog, InlineAlert, Input } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { shiftRecordsAction, type MovePlan } from "@/components/schedule/actions";
import type { ActionError } from "@/components/work/action-result";
import { ActionErrorAlert } from "@/components/work/action-ui";

type Translate = (key: string, values?: Record<string, string | number>) => string;

const PRESETS = [-30, -15, 15, 30, 60] as const;
const LIMIT = 10_080;

/** Minutes with their sign, +15 or -30, as the copy shows them. */
export const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

/**
 * Shift time across a selection of records (Section 11.7 and 11.11, P8), loaded with next/dynamic
 * from the bulk bar the first time someone opens it, so no records page carries it. The minutes are
 * signed; Preview asks app.shift_records what moves (the selected records, the successors pushed
 * outside the selection, by name, and the undated or canceled ones it leaves where they are), Apply
 * commits exactly that in one transaction. The caller puts the result on the undo stack, with the
 * inverse rows worked out here (the old dates, expecting the new, so an undo after someone else's
 * change is refused).
 */
export function ShiftDialog({
  org,
  ids,
  labels,
  onClose,
  onDone,
}: {
  org: string;
  ids: readonly string[];
  labels: ReadonlyMap<string, string>;
  onClose: () => void;
  /** A committed shift, with the rows that undo it through app.bulk_update_records. */
  onDone: (plan: MovePlan<ShiftMove>, minutes: number, undo: readonly BulkRow[]) => void;
}) {
  const t = useTranslations("collab.bulk.shift") as unknown as Translate;
  const router = useRouter();
  const [raw, setRaw] = useState("15");
  const [plan, setPlan] = useState<MovePlan<ShiftMove> | null>(null);
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, start] = useTransition();

  const minutes = /^[+-]?\d{1,5}$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  const valid = Number.isInteger(minutes) && minutes !== 0 && Math.abs(minutes) <= LIMIT;

  const choose = (next: string) => {
    setRaw(next);
    setPlan(null);
    setError(null);
  };

  const run = (commit: boolean) =>
    start(async () => {
      const result = await shiftRecordsAction(org, { recordIds: [...ids], minutes, commit });
      if (!result.ok) {
        setError(result.error);
        setPlan(null);
        return;
      }
      setError(null);
      if (commit) {
        router.refresh();
        onDone(result.data, minutes, shiftUndoRows(result.data.moves));
        return;
      }
      setPlan(result.data);
    });

  const selected = plan?.moves.filter((m) => m.isTarget) ?? [];
  const pushed = plan?.moves.filter((m) => !m.isTarget) ?? [];
  const skipped = plan ? ids.length - selected.length : 0;
  const name = (id: string) => plan?.labels[id] ?? labels.get(id) ?? t("someRecord");

  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t("title", { count: ids.length })}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("cancel")}
          </Button>
          {plan === null || selected.length === 0 ? (
            <Button loading={pending} disabled={!valid} onClick={() => run(false)}>
              {t("preview")}
            </Button>
          ) : (
            <Button variant="primary" loading={pending} onClick={() => run(true)}>
              {t("apply", { count: plan.moves.length })}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-12 text-text-primary">
        <Input
          id="bulk-shift-minutes"
          label={t("minutes")}
          help={t("minutesHelp")}
          inputMode="numeric"
          value={raw}
          {...(raw.trim() !== "" && !valid ? { error: t("minutesInvalid") } : {})}
          onChange={(e) => choose(e.target.value)}
        />
        <div role="group" aria-label={t("presets")} className="flex flex-wrap gap-6">
          {PRESETS.map((p) => (
            <Button
              key={p}
              variant="ghost"
              size="sm"
              aria-pressed={minutes === p}
              onClick={() => choose(signed(p))}
            >
              {t("preset", { minutes: signed(p) })}
            </Button>
          ))}
        </div>
        <ActionErrorAlert error={error} />
        {plan ? (
          <div role="status" className="flex flex-col gap-4 text-text-13">
            {selected.length === 0 ? (
              <p className="m-0">{t("nothing")}</p>
            ) : (
              <p className="m-0 font-medium">
                {t("moves", { count: selected.length, minutes: signed(minutes) })}
              </p>
            )}
            {pushed.length > 0 ? (
              <>
                <p className="m-0">{t("pushed", { count: pushed.length })}</p>
                <ul className="m-0 flex list-disc flex-col gap-2 ps-20">
                  {pushed.slice(0, 20).map((m) => (
                    <li key={m.recordId}>{name(m.recordId)}</li>
                  ))}
                </ul>
                {pushed.length > 20 ? (
                  <p className="m-0 text-text-secondary">
                    {t("pushedMore", { count: pushed.length - 20 })}
                  </p>
                ) : null}
              </>
            ) : null}
            {skipped > 0 ? (
              <p className="m-0 text-text-secondary">{t("skipped", { count: skipped })}</p>
            ) : null}
          </div>
        ) : null}
        {plan === null && !error ? <InlineAlert tone="info">{t("explain")}</InlineAlert> : null}
      </div>
    </Dialog>
  );
}
