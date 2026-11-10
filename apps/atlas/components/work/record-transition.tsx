"use client";

import type { RecordSummary } from "@xos/data/work";
import { Button, Drawer, Textarea } from "@xos/ui";
import { useState } from "react";
import { undoStack, type UndoResult } from "@xos/ui/undo";
import { stateChange } from "@/components/undo/entries";
import type { ActionResult } from "./action-result";
import { ActionErrorAlert, useAction, useCopy } from "./action-ui";
import { transitionRecordAction } from "./actions";

/*
 * A record's state moves (Record template, Section 11.6): the move buttons, the move form and the undo of a move. Its
 * own module, apart from record-panels' editors, so a collection that moves records from its rows carries only this,
 * and the peek's editors load when a peek opens (ADR 0027).
 */

// State moves ---------------------------------------------------------------------------------------------

/** An action's outcome as the undo stack reads it: the catalog sentence when it was refused. */
export function useUndoOutcome() {
  const t = useCopy("work");
  return (result: ActionResult): UndoResult =>
    result.ok ? { ok: true } : { ok: false, message: t(`errors.${result.error.key}`) };
}

/**
 * Puts a record's move on the undo stack (Section 11.7): undo moves it back, compare-and-set on the state it
 * moved to, and names the blocker or replan reason again when it goes back to Blocked or Deferred; redo makes the
 * move again with its own reason. The move's reason is the record ledger's: undoing writes its own entry.
 */
export function useStateUndo(org: string) {
  const t = useCopy("work");
  const outcome = useUndoOutcome();
  return (
    record: RecordSummary,
    next: string,
    move: { reason: string; blockerText?: string | null; replanReason?: string | null },
  ) =>
    undoStack.push(
      stateChange({
        label: t("undo.moved", { key: record.key, state: t(`states.${next}`) }),
        from: record.state,
        to: next,
        move: async (expected, target) => {
          const back = target === record.state;
          return outcome(
            await transitionRecordAction(org, {
              recordId: record.id,
              expected,
              next: target,
              reason: back ? t("undo.reason") : move.reason,
              blockerText:
                target === "Blocked"
                  ? back
                    ? record.blockerText
                    : (move.blockerText ?? null)
                  : null,
              replanReason:
                target === "Deferred"
                  ? back
                    ? record.replanReason
                    : (move.replanReason ?? null)
                  : null,
            }),
          );
        },
      }),
    );
}

/** The states a record may move to, as buttons that open the move form. */
export function TransitionControls({
  org,
  record,
  next,
}: {
  org: string;
  record: RecordSummary;
  next: readonly string[];
}) {
  const t = useCopy("work");
  const [target, setTarget] = useState<string | null>(null);
  if (next.length === 0) {
    return <p className="m-0 text-text-13 text-text-secondary">{t("transition.none")}</p>;
  }
  return (
    <div className="flex flex-col gap-8">
      <h2 className="m-0 text-label-13 font-semibold">{t("transition.title")}</h2>
      {/* The record.state shortcut focuses the first move, so the next Enter or Tab picks one. */}
      <div data-shortcut="record.state" data-shortcut-focus="" className="flex flex-wrap gap-6">
        {next.map((state) => (
          <Button key={state} size="sm" onClick={() => setTarget(state)}>
            {t("transition.to", { state: t(`states.${state}`) })}
          </Button>
        ))}
      </div>
      {target ? (
        <TransitionDialog org={org} record={record} next={target} onClose={() => setTarget(null)} />
      ) : null}
    </div>
  );
}

/** The move form: a reason always, a blocker for Blocked and a replan reason for Deferred. */
export function TransitionDialog({
  org,
  record,
  next,
  onClose,
}: {
  org: string;
  record: RecordSummary;
  next: string;
  onClose: () => void;
}) {
  const t = useCopy("work");
  const { pending, error, run } = useAction();
  const pushUndo = useStateUndo(org);
  const [reason, setReason] = useState("");
  const [blocker, setBlocker] = useState("");
  const [replan, setReplan] = useState("");
  const needsBlocker = next === "Blocked";
  const needsReplan = next === "Deferred";
  const ready =
    reason.trim() !== "" &&
    (!needsBlocker || blocker.trim() !== "") &&
    (!needsReplan || replan.trim() !== "");
  return (
    <Drawer
      title={t("transition.dialogTitle", { key: record.key, state: t(`states.${next}`) })}
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("actions.cancel")}
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={!ready}
            onClick={() =>
              run(
                () =>
                  transitionRecordAction(org, {
                    recordId: record.id,
                    expected: record.state,
                    next,
                    reason,
                    blockerText: needsBlocker ? blocker : null,
                    replanReason: needsReplan ? replan : null,
                  }),
                () => {
                  pushUndo(record, next, {
                    reason,
                    blockerText: needsBlocker ? blocker : null,
                    replanReason: needsReplan ? replan : null,
                  });
                  onClose();
                },
              )
            }
          >
            {t("transition.submit")}
          </Button>
        </>
      }
    >
      <ActionErrorAlert error={error} />
      <Textarea
        id="transition-reason"
        label={t("transition.reason")}
        help={t("transition.reasonHelp")}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      {needsBlocker ? (
        <Textarea
          id="transition-blocker"
          label={t("transition.blocker")}
          help={t("transition.blockerHelp")}
          value={blocker}
          onChange={(e) => setBlocker(e.target.value)}
        />
      ) : null}
      {needsReplan ? (
        <Textarea
          id="transition-replan"
          label={t("transition.replan")}
          help={t("transition.replanHelp")}
          value={replan}
          onChange={(e) => setReplan(e.target.value)}
        />
      ) : null}
    </Drawer>
  );
}
