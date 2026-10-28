import type { UndoAction, UndoResult } from "./undo-stack";

/*
 * The kinds of entry inline edits put on the undo stack (Section 11.7, ADR 0077), each with its inverse. Every
 * inverse goes back through the server and expects what the action left, so an undo over a later change by
 * someone else is refused and the entry stays.
 */

export type FieldValue = string | number | boolean | null;
export type FieldValues = Readonly<Record<string, FieldValue>>;

/** Two field values are the same: equal, both unset, or two spellings of one instant. */
export function sameValue(a: FieldValue | undefined, b: FieldValue | undefined): boolean {
  if ((a ?? null) === (b ?? null)) return true;
  if (typeof a === "string" && typeof b === "string") {
    const instant = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
    if (instant.test(a) && instant.test(b)) {
      const x = Date.parse(a);
      return !Number.isNaN(x) && x === Date.parse(b);
    }
  }
  return false;
}

/** The fields an edit changed: their values before and after, nothing else. */
export function changedFields<V extends FieldValues>(
  before: V,
  after: V,
): {
  readonly before: Partial<V>;
  readonly after: Partial<V>;
  readonly keys: (keyof V & string)[];
} {
  const keys = (Object.keys(after) as (keyof V & string)[]).filter(
    (k) => !sameValue(before[k], after[k]),
  );
  const pick = (values: V) =>
    Object.fromEntries(keys.map((k) => [k, values[k] ?? null])) as Partial<V>;
  return { before: pick(before), after: pick(after), keys };
}

/**
 * A property edit: undo writes the values before, expecting the values after; redo writes the values after,
 * expecting the values before.
 */
export function propertyEdit<V extends FieldValues>(input: {
  readonly label: string;
  readonly before: V;
  readonly after: V;
  readonly save: (set: V, expect: V) => Promise<UndoResult>;
  readonly toast?: boolean;
}): UndoAction {
  return {
    label: input.label,
    ...(input.toast === undefined ? {} : { toast: input.toast }),
    undo: () => input.save(input.before, input.after),
    redo: () => input.save(input.after, input.before),
  };
}

/**
 * A state change: undo moves back from the new state to the old one, redo moves forward again. `move` is
 * compare-and-set on the state it leaves.
 */
export function stateChange(input: {
  readonly label: string;
  readonly from: string;
  readonly to: string;
  readonly move: (expected: string, next: string) => Promise<UndoResult>;
  readonly toast?: boolean;
}): UndoAction {
  return {
    label: input.label,
    ...(input.toast === undefined ? {} : { toast: input.toast }),
    undo: () => input.move(input.to, input.from),
    redo: () => input.move(input.from, input.to),
  };
}

/** A delete to Trash: undo restores, redo deletes again. */
export function softDelete(input: {
  readonly label: string;
  readonly restore: () => Promise<UndoResult>;
  readonly remove: () => Promise<UndoResult>;
  readonly toast?: boolean;
}): UndoAction {
  return {
    label: input.label,
    ...(input.toast === undefined ? {} : { toast: input.toast }),
    undo: input.restore,
    redo: input.remove,
  };
}

/** A two-way switch such as a checklist item: undo sets the value before, redo the value after. */
export function toggle(input: {
  readonly label: string;
  readonly after: boolean;
  readonly set: (value: boolean) => Promise<UndoResult>;
  readonly toast?: boolean;
}): UndoAction {
  return {
    label: input.label,
    ...(input.toast === undefined ? {} : { toast: input.toast }),
    undo: () => input.set(!input.after),
    redo: () => input.set(input.after),
  };
}

/**
 * The versions this tab's own saves left, row by row, for edits whose server check is the row's version alone (a
 * budget line). Each save records the version it was sent against and the one it produced. An undo or a redo saves
 * against the end of its entry's chain: past this tab's own later saves of the row, which an earlier edit's undo may
 * follow, but never past a save by someone else, which no save here started from. Such an undo goes against an old
 * version and the server refuses it.
 */
export function versionChain() {
  const next = new Map<string, string>();
  const key = (id: string, version: string) => `${id}@${version}`;
  return {
    /** A save of row `id` sent against `from` committed and left `to`. */
    record(id: string, from: string, to: string) {
      if (from && to && from !== to) next.set(key(id, from), to);
    },
    /** The version row `id` holds after this tab's own saves that followed `version`. */
    latest(id: string, version: string): string {
      let current = version;
      // Versions only grow, so a chain never loops; the bound keeps a bad entry from spinning.
      for (let step = 0; step <= next.size; step += 1) {
        const after = next.get(key(id, current));
        if (after === undefined) break;
        current = after;
      }
      return current;
    },
  };
}
