/**
 * The session's undo stack (Section 11.7, ADR 0044): the last 50 reversible actions in this tab, in
 * order. Cmd or Ctrl+Z undoes the latest and Shift+Cmd or Ctrl+Z redoes it (the shell answers the
 * registry's `undo` and `redo` shortcuts); inside a text field the keys stay the field's own.
 *
 * Every entry undoes through the server: a bulk change sends its inverse rows back through the
 * same RPC, a trashed record is restored. The server refuses an undo that would overwrite a later
 * change by someone else, and the entry then stays where it was, so nothing is lost silently. Toasts
 * show one entry; their Undo button and Cmd or Ctrl+Z act on the same stack.
 */

export type UndoResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

export interface UndoAction {
  /** What the action did, in a sentence: "Changed 3 records." */
  readonly label: string;
  readonly undo: () => Promise<UndoResult>;
  /** Redoes the action; without it, an undone action leaves the stack. */
  readonly redo?: () => Promise<UndoResult>;
  /** False when the caller shows its own Undo toast; the shell shows one otherwise. */
  readonly toast?: boolean;
}

export interface UndoEntry extends UndoAction {
  readonly id: number;
}

export type UndoEvent =
  | { readonly kind: "pushed"; readonly entry: UndoEntry }
  | { readonly kind: "undone" | "redone"; readonly entry: UndoEntry }
  | { readonly kind: "failed"; readonly entry: UndoEntry; readonly message: string }
  | { readonly kind: "empty"; readonly direction: "undo" | "redo" };

export const UNDO_LIMIT = 50;

export interface UndoStack {
  push(action: UndoAction): UndoEntry;
  /** Undoes the latest action, or the given one (a toast's Undo button). */
  undo(id?: number): Promise<void>;
  redo(): Promise<void>;
  /** Whether an action is still undoable (a toast hides its button once it is not). */
  has(id: number): boolean;
  size(): { readonly past: number; readonly future: number };
  subscribe(listener: (event: UndoEvent) => void): () => void;
}

export function createUndoStack(limit = UNDO_LIMIT): UndoStack {
  let past: UndoEntry[] = [];
  let future: UndoEntry[] = [];
  let next = 1;
  let busy = false;
  const listeners = new Set<(event: UndoEvent) => void>();
  const emit = (event: UndoEvent) => {
    for (const listener of listeners) listener(event);
  };

  return {
    push(action) {
      const entry: UndoEntry = { ...action, id: next };
      next += 1;
      past = [...past, entry].slice(-limit);
      future = [];
      emit({ kind: "pushed", entry });
      return entry;
    },
    async undo(id) {
      if (busy) return;
      const entry = id === undefined ? past.at(-1) : past.find((e) => e.id === id);
      if (!entry) {
        emit({ kind: "empty", direction: "undo" });
        return;
      }
      busy = true;
      try {
        const result = await entry.undo();
        if (!result.ok) {
          emit({ kind: "failed", entry, message: result.message });
          return;
        }
        past = past.filter((e) => e !== entry);
        if (entry.redo) future = [...future, entry].slice(-limit);
        emit({ kind: "undone", entry });
      } catch (error) {
        emit({ kind: "failed", entry, message: error instanceof Error ? error.message : "" });
      } finally {
        busy = false;
      }
    },
    async redo() {
      if (busy) return;
      const entry = future.at(-1);
      if (!entry?.redo) {
        emit({ kind: "empty", direction: "redo" });
        return;
      }
      busy = true;
      try {
        const result = await entry.redo();
        if (!result.ok) {
          emit({ kind: "failed", entry, message: result.message });
          return;
        }
        future = future.filter((e) => e !== entry);
        past = [...past, entry].slice(-limit);
        emit({ kind: "redone", entry });
      } catch (error) {
        emit({ kind: "failed", entry, message: error instanceof Error ? error.message : "" });
      } finally {
        busy = false;
      }
    },
    has: (id) => past.some((e) => e.id === id),
    size: () => ({ past: past.length, future: future.length }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The tab's stack; it survives client navigation and ends with the tab. */
export const undoStack: UndoStack = createUndoStack();
