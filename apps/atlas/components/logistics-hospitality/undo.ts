"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";
import { undoStack, type UndoEntry, type UndoResult } from "@/components/undo/undo-stack";
import type { ActionState } from "@/lib/logistics-hospitality/actions-kit";

type Translate = (key: string) => string;

/** A move to Trash that can be taken back: the toast's sentence, the move and the restore. */
export interface TrashMove {
  readonly message: string;
  readonly run: () => Promise<ActionState>;
  readonly restore: () => Promise<ActionState>;
}

/**
 * Puts a Logistics or Hospitality move to Trash on the session's undo stack (Section 11.7): the
 * toast's Undo and Cmd or Ctrl+Z restore the row, and redo moves it to Trash again. A refused undo
 * says why in the module's words and stays on the stack. With `toast: false` the caller shows its
 * own Undo toast; otherwise the shell's toast shows the same sentence, which outlives a peek that
 * closes after the delete.
 */
export function usePushTrash(): (move: TrashMove, options?: { toast?: boolean }) => UndoEntry {
  const t = useTranslations("logistics.common.errors") as unknown as Translate;
  return useCallback(
    (move, options = {}) => {
      const asUndo = async (action: () => Promise<ActionState>): Promise<UndoResult> => {
        const state = await action();
        return state.ok ? { ok: true } : { ok: false, message: t(state.error ?? "unexpected") };
      };
      return undoStack.push({
        label: move.message,
        undo: () => asUndo(move.restore),
        redo: () => asUndo(move.run),
        ...(options.toast === false ? { toast: false } : {}),
      });
    },
    [t],
  );
}
