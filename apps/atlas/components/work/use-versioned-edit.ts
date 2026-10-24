"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import {
  changedFields,
  propertyEdit,
  sameValue,
  type FieldValues,
} from "@/components/undo/entries";
import { undoStack, type UndoResult } from "@/components/undo/undo-stack";
import type { ActionError, VersionedResult } from "./action-result";
import { useCopy } from "./action-ui";

/** A save someone else's change refused: what the person sent, what they started from, and the row now. */
export interface PendingConflict<V extends FieldValues> {
  readonly mine: Partial<V>;
  readonly base: Partial<V>;
  readonly theirs: Partial<V>;
  readonly version: string | null;
  /** Fields both people changed, to different values: the dialog's rows. */
  readonly clashing: readonly (keyof V & string)[];
}

type Save<V extends FieldValues> = (input: {
  readonly set: Partial<V>;
  readonly expect: Partial<V>;
  readonly version: string | null;
  /** True for an undo or a redo, which carries nothing typed beside the fields (a replan reason). */
  readonly undoing?: boolean;
}) => Promise<VersionedResult<Partial<V>>>;

function pick<V extends FieldValues>(values: Partial<V>, keys: readonly string[]): Partial<V> {
  return Object.fromEntries(keys.map((k) => [k, values[k] ?? null])) as Partial<V>;
}

/**
 * Inline edits of a record's properties (Section 11.7, ADR 0077). A save sends only the fields that changed, the
 * values the person started from and the version they loaded. A saved edit goes on the undo stack with its inverse;
 * a stale one opens the mine-or-theirs choice, whose rows are only the fields both people changed: fields only the
 * person changed save with either choice.
 */
export function useVersionedEdit<V extends FieldValues>({
  label,
  save,
  onSaved,
}: {
  /** The undo stack entry's sentence. */
  label: string;
  save: Save<V>;
  /** After a save lands: the values it replaced and wrote, and the new version. */
  onSaved: (applied: { before: Partial<V>; after: Partial<V>; version: string | null }) => void;
}) {
  const t = useCopy("work");
  const [pending, start] = useTransition();
  const [error, setError] = useState<ActionError | null>(null);
  const [conflict, setConflict] = useState<PendingConflict<V> | null>(null);

  const outcome = useCallback(
    (result: VersionedResult<Partial<V>>): UndoResult =>
      result.ok
        ? { ok: true }
        : {
            ok: false,
            message:
              "conflict" in result ? t("undo.changedSince") : t(`errors.${result.error.key}`),
          },
    [t],
  );

  const send = useCallback(
    (set: Partial<V>, expect: Partial<V>, version: string | null, base: Partial<V>) =>
      start(async () => {
        setError(null);
        const result = await save({ set, expect, version });
        if (result.ok) {
          setConflict(null);
          onSaved({ before: expect, after: set, version: result.data.version });
          undoStack.push(
            propertyEdit({
              label,
              before: expect as V,
              after: set as V,
              save: async (s, e) =>
                outcome(await save({ set: s, expect: e, version: null, undoing: true })),
            }),
          );
          return;
        }
        if (!("conflict" in result)) {
          setError(result.error);
          return;
        }
        const theirs = result.conflict.theirs;
        const keys = Object.keys(set);
        const clashing = keys.filter(
          (k) => !sameValue(theirs[k], base[k]) && !sameValue(theirs[k], set[k]),
        ) as (keyof V & string)[];
        setConflict({ mine: set, base, theirs, version: result.conflict.version, clashing });
      }),
    [label, onSaved, outcome, save],
  );

  /** Saves the fields that changed between `before` and `after`, against `version`. */
  const submit = useCallback(
    (before: V, after: V, version: string | null) => {
      const diff = changedFields(before, after);
      if (diff.keys.length === 0) {
        onSaved({ before: {}, after: {}, version });
        return;
      }
      send(diff.after, diff.before, version, diff.before);
    },
    [onSaved, send],
  );

  /** Keeps the person's values: saves them again against the version that came back. */
  const keepMine = useCallback(() => {
    if (!conflict) return;
    send(
      conflict.mine,
      pick(conflict.theirs, Object.keys(conflict.mine)),
      conflict.version,
      conflict.theirs,
    );
  }, [conflict, send]);

  /**
   * Takes theirs for the fields both people changed; the fields only the person changed still save. Returns the
   * values the form should show for the clashing fields.
   */
  const takeTheirs = useCallback((): Partial<V> => {
    if (!conflict) return {};
    const clean = Object.keys(conflict.mine).filter(
      (k) => !conflict.clashing.includes(k as keyof V & string),
    );
    setConflict(null);
    if (clean.length > 0) {
      send(
        pick(conflict.mine, clean),
        pick(conflict.theirs, clean),
        conflict.version,
        conflict.theirs,
      );
    }
    return pick(conflict.theirs, conflict.clashing);
  }, [conflict, send]);

  // A conflict whose only differences are fields both people set alike needs no choice: keep mine at once.
  const silent = conflict !== null && conflict.clashing.length === 0;
  useEffect(() => {
    if (silent) keepMine();
  }, [silent, keepMine]);

  return {
    pending,
    error,
    conflict: silent ? null : conflict,
    submit,
    keepMine,
    takeTheirs,
    clear: () => setError(null),
  };
}
