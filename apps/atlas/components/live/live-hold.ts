/**
 * Holds on live refreshes (Section 11.7). A dialog that shows something a refresh would take off
 * screen for good, such as a signing link and access code shown once (invariant 8), holds the
 * page's live refreshes while it is open. A change that arrives meanwhile is not lost: each page
 * that wanted to reread does so once the last hold is released.
 */
const holds = new Set<symbol>();
const waiting = new Map<object, () => void>();

/** Holds live refreshes until the returned release is called; releasing twice does nothing. */
export function holdLiveRefresh(): () => void {
  const hold = Symbol("live-hold");
  holds.add(hold);
  return () => {
    if (!holds.delete(hold) || holds.size > 0) return;
    const queued = [...waiting.values()];
    waiting.clear();
    for (const refresh of queued) refresh();
  };
}

/** Whether any hold is in place. */
export function liveRefreshHeld(): boolean {
  return holds.size > 0;
}

/**
 * Runs `refresh` now, or once the last hold is released. `key` names the page that wants it, so a
 * burst of changes during a hold rereads each page only once.
 */
export function refreshWhenFree(key: object, refresh: () => void): void {
  if (holds.size === 0) refresh();
  else waiting.set(key, refresh);
}

/** Forgets a waiting refresh, for a page that leaves before the hold is released. */
export function forgetWaitingRefresh(key: object): void {
  waiting.delete(key);
}
