/**
 * Outcome notices for actions the undo stack cannot take back (a signature, a withdrawal): the
 * shell's UndoCenter shows them in its one polite region, so every outcome reads in the same place.
 */
const listeners = new Set<(message: string) => void>();

export function notify(message: string): void {
  for (const listener of listeners) listener(message);
}

export function onNotice(listener: (message: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
