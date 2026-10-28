"use client";

import {
  CUE_CALL_KINDS,
  CUE_CALL_SLUGS,
  type Cue,
  type CueCall,
  type CueCallKind,
  type RunOfShow,
} from "@xos/data/show";
import { Button, Checkbox, Dialog, Input, Select, Textarea } from "@xos/ui";
import { useState } from "react";
import { ActionErrorAlert, useAction, useCopy } from "@/components/work/action-ui";
import { fromLocalInput, toLocalInput } from "@/components/work/format";
import { moveCueToAction, saveCueCallsAction, updateCueAction } from "./actions";

/**
 * The run of show's inline cue editor and Move to position dialog (G-78, ADR 0131). runs.tsx loads
 * this module with next/dynamic when a person opens either, so the route keeps its weight.
 */

/** HH:MM in the run's zone, for a time input. */
function timeOf(at: string | null, zone: string): string {
  return at ? toLocalInput(at, zone).slice(11, 16) : "";
}

/**
 * One cue edited in place of its row: label, planned time, Time to be confirmed, length and the five
 * department calls. Save writes the cue, then its calls; when the calls fail the editor stays open
 * with what the person typed and says why. Escape cancels.
 */
export function CueEditor({
  org,
  run,
  cue,
  calls,
  onClose,
}: {
  org: string;
  run: RunOfShow;
  cue: Cue;
  calls: readonly CueCall[];
  onClose: () => void;
}) {
  const t = useCopy("show");
  const save = useAction();
  const zone = run.timeZone;
  const [label, setLabel] = useState(cue.label);
  const [planned, setPlanned] = useState(timeOf(cue.plannedAt, zone));
  const [startTbc, setStartTbc] = useState(cue.startTbc);
  const [duration, setDuration] = useState(
    cue.durationSeconds === null ? "" : String(cue.durationSeconds),
  );
  const initial = Object.fromEntries(
    CUE_CALL_KINDS.map((k) => [k, calls.find((c) => c.kind === k)?.instruction ?? ""]),
  ) as Record<CueCallKind, string>;
  const [instructions, setInstructions] = useState(initial);
  // The planned day is the cue's own, or the show day for a cue that had no time.
  const day = cue.plannedAt ? toLocalInput(cue.plannedAt, zone).slice(0, 10) : run.showDate;
  const department = (k: CueCallKind) => t(`cues.departments.${CUE_CALL_SLUGS[k]}`);

  const submit = () =>
    save.run(
      async () => {
        const updated = await updateCueAction(org, cue.id, {
          label,
          plannedAt: planned ? fromLocalInput(`${day}T${planned}`, zone) : null,
          durationSeconds: duration === "" ? null : Number(duration),
          startTbc: planned !== "" && startTbc,
        });
        if (!updated.ok) return updated;
        // Only departments whose text changed are sent; an emptied one clears its call.
        const changed = Object.fromEntries(
          CUE_CALL_KINDS.filter((k) => instructions[k].trim() !== initial[k].trim()).map((k) => [
            k,
            instructions[k].trim() === "" ? null : instructions[k].trim(),
          ]),
        );
        if (Object.keys(changed).length === 0) return updated;
        return saveCueCallsAction(org, cue.id, changed);
      },
      () => onClose(),
    );

  return (
    <form
      aria-label={t("cues.editing", { label: cue.label })}
      className="flex w-full flex-col gap-8 py-6"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <ActionErrorAlert error={save.error} />
      <div className="flex flex-wrap items-end gap-8">
        <Input
          id={`cue-edit-label-${cue.id}`}
          label={t("cues.label")}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        {cue.calledAt ? null : (
          <>
            <Input
              id={`cue-edit-time-${cue.id}`}
              type="time"
              label={t("cues.planned")}
              value={planned}
              onChange={(e) => setPlanned(e.target.value)}
            />
            <Checkbox
              label={t("cues.tbc")}
              checked={planned !== "" && startTbc}
              disabled={planned === ""}
              onChange={(e) => setStartTbc(e.target.checked)}
            />
          </>
        )}
        <Input
          id={`cue-edit-duration-${cue.id}`}
          type="number"
          min={0}
          width={120}
          label={t("cues.duration")}
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
        />
      </div>
      <div className="grid grid-cols-2 gap-8 max-sm:grid-cols-1">
        {CUE_CALL_KINDS.map((k) => (
          <Textarea
            key={k}
            id={`cue-edit-call-${CUE_CALL_SLUGS[k]}-${cue.id}`}
            label={t("cues.callFor", { department: department(k) })}
            rows={2}
            maxLength={2000}
            value={instructions[k]}
            onChange={(e) => setInstructions((v) => ({ ...v, [k]: e.target.value }))}
          />
        ))}
      </div>
      <div className="flex gap-8">
        <Button
          type="submit"
          variant="primary"
          loading={save.pending}
          disabled={label.trim() === ""}
        >
          {t("cues.save")}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t("cues.cancel")}
        </Button>
      </div>
    </form>
  );
}

/**
 * Move to position: a select of the running order's places ("2 · Walk-in Music Out") that moves the
 * cue there in one step (app.move_cue). Places at or before the last called cue are not offered.
 */
export function MoveCueDialog({
  org,
  runId,
  cues,
  cue,
  onClose,
}: {
  org: string;
  runId: string;
  cues: readonly Cue[];
  cue: Cue;
  onClose: () => void;
}) {
  const t = useCopy("show");
  const move = useAction();
  const lastCalled = cues.reduce((last, c, i) => (c.calledAt ? i + 1 : last), 0);
  const here = cues.findIndex((c) => c.id === cue.id) + 1;
  const options = cues
    .map((c, i) => ({
      value: String(i + 1),
      label: t("cues.moveOption", { n: i + 1, label: c.label }),
    }))
    .filter((o) => Number(o.value) > lastCalled);
  const [place, setPlace] = useState(String(here));
  return (
    <Dialog
      title={t("cues.moveTitle", { label: cue.label })}
      description={t("cues.moveBody")}
      open
      onOpenChange={(v) => (v ? undefined : onClose())}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("cues.cancel")}
          </Button>
          <Button
            variant="primary"
            loading={move.pending}
            disabled={Number(place) === here}
            onClick={() =>
              move.run(() => moveCueToAction(org, runId, cue.id, Number(place)), onClose)
            }
          >
            {t("cues.moveConfirm")}
          </Button>
        </>
      }
    >
      <ActionErrorAlert error={move.error} />
      <Select
        id={`cue-move-${cue.id}`}
        label={t("cues.movePosition")}
        value={place}
        options={options}
        onChange={(e) => setPlace(e.target.value)}
      />
    </Dialog>
  );
}
