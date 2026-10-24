"use client";

import { Button } from "@xos/ui";
import { useState, useTransition } from "react";
import { type ActionState } from "@/app/[org]/finance/actions";
import { softDelete } from "@/components/undo/entries";
import { undoStack, type UndoResult } from "@/components/undo/undo-stack";
import { ActionFeedback } from "./kit-action-feedback";
import { useFinanceT } from "./kit-use-finance-t";

/**
 * Removes an invoice or settlement line to Trash with an 8-second Undo (Section 11.7, ADR 0077). The removal goes
 * on the session's undo stack, whose toast the shell shows: its Undo, or Cmd or Ctrl+Z, restores the line through
 * the Trash RPC, and redo removes it again. The line's own rules decide both ways, so a line whose invoice or
 * settlement has moved on from Proposed is not restored.
 */
export function LineDeleteButton({
  action,
  org,
  id,
  description,
  label,
}: {
  /** The line's save action, which removes with delete=1 and restores with restore=1. */
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  org: string;
  id: string;
  /** The line's description, for the toast. */
  description: string;
  label: string;
}) {
  const t = useFinanceT();
  const [state, setState] = useState<ActionState>({});
  const [pending, start] = useTransition();
  const call = (flag: "delete" | "restore") => {
    const form = new FormData();
    form.set("org", org);
    form.set("id", id);
    form.set(flag, "1");
    return action({}, form);
  };
  // A refusal reads in the catalog's words (finance.refusals), never the database's sentence.
  const outcome = (result: ActionState): UndoResult => {
    if (result.ok) return { ok: true };
    const error = result.error;
    const key = error?.kind === "refusal" ? `refusals.${error.rule}` : null;
    return { ok: false, message: key && t.has(key) ? t(key) : t("common.lineUndo") };
  };
  return (
    <span className="inline-flex flex-col gap-4">
      <Button
        variant="ghost"
        size="sm"
        icon="Trash2"
        loading={pending}
        onClick={() =>
          start(async () => {
            const result = await call("delete");
            setState(result);
            if (!result.ok) return;
            undoStack.push(
              softDelete({
                label: t("common.lineRemoved", { description }),
                restore: async () => outcome(await call("restore")),
                remove: async () => outcome(await call("delete")),
              }),
            );
          })
        }
      >
        {label}
      </Button>
      <ActionFeedback state={state} />
    </span>
  );
}
