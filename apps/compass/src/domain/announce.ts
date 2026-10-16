/**
 * What Compass says to a screen reader when a status changes in place (A23-004, WCAG 4.1.3): scan results,
 * clock punches, punches saved offline, the offline queue count and toasts. iOS has no live regions, so
 * each of these goes through @xos/ui-native's announce; these builders decide the words.
 */
import type { PunchKind } from "./clock";

/** Catalog key spoken after a punch: what happened, or that it waits on this device to upload. */
export function punchAnnouncementKey(kind: PunchKind, online: boolean): string {
  if (!online) return "compass.clock.queued";
  switch (kind) {
    case "In":
      return "compass.announce.clockedIn";
    case "Break Start":
      return "compass.announce.breakStarted";
    case "Break End":
      return "compass.announce.breakEnded";
    case "Out":
      return "compass.announce.clockedOut";
  }
}

/**
 * The queue count change worth saying: more writes waiting, fewer waiting, or all uploaded. Nothing on
 * the first reading (the screen just opened) or when the count did not change.
 */
export function queueAnnouncement(
  previous: number | null,
  next: number,
): { key: string; count?: number } | null {
  if (previous === null || previous === next) return null;
  if (next === 0) return { key: "compass.sync.uploaded" };
  return { key: next === 1 ? "compass.sync.queuedOne" : "compass.sync.queuedOther", count: next };
}

/** A scan result as one sentence: what was scanned and the code. */
export function scanAnnouncement(result: { ok: boolean; title: string; code: string }): string {
  return result.title;
}
