/**
 * Run of show (Section 4.3 item 9, Section 11.13 Show): live cue progression and time to the next cue.
 * Show mode is large type, dark, kept awake, with a haptic before each cue.
 */
import type { MutationInput } from "@xos/sync";

export interface Cue {
  readonly id: string;
  readonly run_of_show_id: string;
  readonly position: number;
  readonly label: string;
  readonly planned_at: string | null;
  /** ISO 8601 duration from Postgres interval output, such as "00:04:30". */
  readonly duration: string | null;
  readonly called_at: string | null;
}

export interface ShowState {
  readonly current: Cue | null;
  readonly next: Cue | null;
  readonly upcoming: readonly Cue[];
  readonly calledCount: number;
  readonly total: number;
  /** Milliseconds until the next cue's planned time; negative when late; null without a planned time. */
  readonly msToNext: number | null;
  readonly status: "standby" | "running" | "late" | "complete";
}

/** Seconds of warning before a cue: the haptic fires when the countdown crosses it (Section 11.13). */
export const PRE_CUE_WARNING_MS = 10_000;

export function showState(cues: readonly Cue[], nowMs: number): ShowState {
  const ordered = [...cues].sort((a, b) => a.position - b.position);
  const called = ordered.filter((c) => c.called_at !== null);
  const current =
    called.sort(
      (a, b) =>
        Date.parse(b.called_at ?? "") - Date.parse(a.called_at ?? "") || b.position - a.position,
    )[0] ?? null;
  const remaining = ordered.filter(
    (c) => c.called_at === null && (current === null || c.position > current.position),
  );
  const next = remaining[0] ?? null;
  const msToNext = next?.planned_at ? Date.parse(next.planned_at) - nowMs : null;
  let status: ShowState["status"] = "running";
  if (next === null) status = ordered.length > 0 && current !== null ? "complete" : "standby";
  else if (current === null) status = "standby";
  else if (msToNext !== null && msToNext < 0) status = "late";
  return {
    current,
    next,
    upcoming: remaining.slice(1, 4),
    calledCount: called.length,
    total: ordered.length,
    msToNext,
    status,
  };
}

/** True exactly when the countdown crosses the warning threshold between two ticks. */
export function preCueHapticDue(previousMsToNext: number | null, msToNext: number | null): boolean {
  if (previousMsToNext === null || msToNext === null) return false;
  return previousMsToNext > PRE_CUE_WARNING_MS && msToNext <= PRE_CUE_WARNING_MS;
}

/** Countdown text: M:SS under an hour, H:MM:SS above; late cues read with a leading plus. */
export function formatCountdown(ms: number): string {
  const late = ms < 0;
  const total = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = (total % 60).toString().padStart(2, "0");
  const body = h > 0 ? `${h}:${m.toString().padStart(2, "0")}:${s}` : `${m}:${s}`;
  return late ? `+${body}` : body;
}

/** Seconds before a cue at which the countdown is spoken; 0 is the cue itself (A23-009). */
export const COUNTDOWN_ANNOUNCE_AT_S: readonly number[] = [60, 30, 10, 0];

/**
 * The point the countdown crossed between two ticks, to speak once, or null. The countdown re-renders
 * every 500 ms, so it never sits in a live region; it is announced only at these points.
 */
export function countdownAnnouncement(
  previousMsToNext: number | null,
  msToNext: number | null,
): number | null {
  if (previousMsToNext === null || msToNext === null) return null;
  const crossed = COUNTDOWN_ANNOUNCE_AT_S.filter(
    (s) => previousMsToNext > s * 1000 && msToNext <= s * 1000,
  );
  return crossed.length === 0 ? null : Math.min(...crossed);
}

/** Whole minutes and seconds of a countdown, for the spoken label ("2 min 10 s to Doors"). */
export function countdownParts(ms: number): {
  readonly late: boolean;
  readonly minutes: number;
  readonly seconds: number;
} {
  const total = Math.floor(Math.abs(ms) / 1000);
  return { late: ms < 0, minutes: Math.floor(total / 60), seconds: total % 60 };
}

/**
 * Calling a cue stamps it once (private.guard_cue). Two operators calling the same cue is not a conflict:
 * the first call stands, so the policy is append and a stale answer is taken as applied.
 */
export function buildCallCue(cue: Cue, nowMs: number): MutationInput {
  const calledAt = new Date(nowMs).toISOString();
  return {
    op: "rpc",
    target: "app.call_cue",
    table: "cues",
    rowId: cue.id,
    payload: { p_cue_id: cue.id },
    policy: "append",
    optimistic: { ...cue, called_at: calledAt },
  };
}
