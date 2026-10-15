/**
 * Offline event time (Section 13: offline punches carry device time, a monotonic clock offset and GPS fix
 * quality; the server accepts them within a skew tolerance and flags the rest).
 *
 * The device wall clock can be wrong or changed by hand; the monotonic clock cannot be changed, but resets
 * on reboot. Whenever the device talks to the server it records an anchor: the server time and the
 * monotonic reading at that moment. An offline event then carries its wall time, the monotonic milliseconds
 * since the anchor and the anchor itself, so the server can compute when the event happened by its own
 * clock and compare.
 */

export interface DeviceClock {
  /** Wall time in milliseconds since the epoch. */
  wallNow(): number;
  /** Monotonic milliseconds since an arbitrary origin; never goes backwards until reboot. */
  monotonicNow(): number;
  /** Changes on every reboot, so a stale anchor from before a reboot is never trusted. */
  bootId(): string;
}

export interface TimeAnchor {
  readonly serverMs: number;
  readonly monotonicMs: number;
  readonly bootId: string;
}

export interface EventTime {
  /** Device wall time, ISO 8601. */
  readonly deviceAt: string;
  /** Monotonic milliseconds since the anchor; null without a valid anchor. */
  readonly monotonicOffsetMs: number | null;
  /** Server time of the anchor, ISO 8601; null without a valid anchor. */
  readonly anchorServerAt: string | null;
  /** When the event happened by the server's clock, ISO 8601; null without a valid anchor. */
  readonly estimatedServerAt: string | null;
  /** Device wall time minus estimated server time, in milliseconds; null without a valid anchor. */
  readonly skewMs: number | null;
  /** The raw monotonic reading and boot at the event, for the age-at-upload the server checks. */
  readonly monotonicAt: number;
  readonly bootId: string;
}

/**
 * Milliseconds between the event and now by the monotonic clock: the offset app.record_punch subtracts
 * from its receive time to place an offline punch. Null after a reboot, when the server falls back to its
 * own skew window.
 */
export function ageAtUpload(
  clock: DeviceClock,
  event: Pick<EventTime, "monotonicAt" | "bootId">,
): number | null {
  if (event.bootId !== clock.bootId()) return null;
  return Math.max(0, Math.round(clock.monotonicNow() - event.monotonicAt));
}

/** Default tolerance before an offline punch is flagged for review: two minutes. */
export const DEFAULT_SKEW_TOLERANCE_MS = 120_000;

export function anchorFromServer(
  clock: DeviceClock,
  serverMs: number,
  roundTripMs = 0,
): TimeAnchor {
  return {
    serverMs: serverMs + Math.round(roundTripMs / 2),
    monotonicMs: clock.monotonicNow(),
    bootId: clock.bootId(),
  };
}

export function stampEvent(clock: DeviceClock, anchor: TimeAnchor | null): EventTime {
  const wall = clock.wallNow();
  const deviceAt = new Date(wall).toISOString();
  const monotonicAt = clock.monotonicNow();
  const bootId = clock.bootId();
  if (!anchor || anchor.bootId !== bootId) {
    return {
      deviceAt,
      monotonicOffsetMs: null,
      anchorServerAt: null,
      estimatedServerAt: null,
      skewMs: null,
      monotonicAt,
      bootId,
    };
  }
  const offset = monotonicAt - anchor.monotonicMs;
  const estimated = anchor.serverMs + offset;
  return {
    monotonicAt,
    bootId,
    deviceAt,
    monotonicOffsetMs: offset,
    anchorServerAt: new Date(anchor.serverMs).toISOString(),
    estimatedServerAt: new Date(estimated).toISOString(),
    skewMs: wall - estimated,
  };
}

/** The device's own view of whether the server will flag this event for review. */
export function needsReview(event: EventTime, toleranceMs = DEFAULT_SKEW_TOLERANCE_MS): boolean {
  return event.skewMs === null || Math.abs(event.skewMs) > toleranceMs;
}
