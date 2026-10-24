import type { DataError } from "@xos/data";
import type { ReactNode } from "react";

/**
 * Keys a collection page hands to the shell's global peek (Section 4.5.3). A collection owns `?peek`
 * on its route; when it shows no row for the key (a stale link, a record key from elsewhere) it hands
 * the key over with PeekHandoff, and the shell opens the record the key names. A small external
 * store: the collection registers while it renders the key, and the shell reads it with
 * useSyncExternalStore, so the decision never waits on a timer or looks for a panel in the page.
 */
export interface PeekHandoff {
  readonly path: string;
  readonly key: string;
}

const NONE: readonly PeekHandoff[] = [];
let handoffs: readonly PeekHandoff[] = NONE;
const listeners = new Set<() => void>();

function publish(next: readonly PeekHandoff[]) {
  handoffs = next;
  for (const listener of listeners) listener();
}

/** Hands `key` on `path` to the shell until the returned release runs. */
export function handOffPeek(path: string, key: string): () => void {
  const entry: PeekHandoff = { path, key };
  publish([...handoffs, entry]);
  return () => publish(handoffs.filter((h) => h !== entry));
}

export function subscribePeekHandoffs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current hand-offs; the same array until one is added or released. */
export function peekHandoffs(): readonly PeekHandoff[] {
  return handoffs;
}

/** None while rendering on the server: hand-offs register in the browser. */
export function serverPeekHandoffs(): readonly PeekHandoff[] {
  return NONE;
}

/**
 * The `?peek` key a collection hands to the shell: the key when the page rendered no panel for it
 * (`panel` renders nothing), else null. A panel still loading (a lazy element) counts as shown.
 */
export function unshownPeekKey(key: string | null, panel: ReactNode): string | null {
  return key !== null && key !== "" && rendersNothing(panel) ? key : null;
}

/**
 * Whether a failed read of the `?peek` row means the collection has no row for the key: none the
 * viewer can read (`not-found`), or a key that is not one of its ids at all (`invalid`: a record key
 * looked up as a UUID, which Postgres rejects with 22P02). The collection hands such a key over, or
 * answers it with its own not-found state; any other failure is the page's to raise.
 */
export function peekRowMissing(error: Pick<DataError, "kind">): boolean {
  return error.kind === "not-found" || error.kind === "invalid";
}

/** True when `node` renders nothing: null, undefined, a boolean, or a list of only those. */
function rendersNothing(node: ReactNode): boolean {
  if (node === null || node === undefined || typeof node === "boolean") return true;
  return Array.isArray(node) && (node as readonly ReactNode[]).every(rendersNothing);
}
