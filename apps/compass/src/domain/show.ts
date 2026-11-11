/**
 * Run of show (Section 4.3 item 9, Section 11.13 Show): live cue progression and time to the next cue.
 * Show mode is large type, dark, kept awake, with a haptic before each cue. Current, next, standby and complete
 * come from @xos/data/show-timing, the same rules Atlas's showcaller console uses (ADR 0131).
 */
import { callLines, isCueCallKind, type CueCallKind, type CueCallLine } from "@xos/data/cue-calls";
import { cueProgress } from "@xos/data/show-timing";
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
  /** True while the planned time is an estimate to be confirmed: shown as TBC, never counted down. */
  readonly start_tbc?: boolean | null;
  /** When the caller put the cue on standby (internal devices only). */
  readonly standby_at?: string | null;
}

/** A department call as the device stores it (app.cue_calls; internal devices only). */
export interface CueCallRow {
  readonly id: string;
  readonly cue_id: string;
  readonly call_kind: string;
  readonly instruction: string;
}

/**
 * The calls a cue card shows (G-74): the chosen department's line, or every line in enum order when the
 * person chose All (null). An empty list with a department chosen reads "No <department> call".
 */
export function cueCallLines(
  calls: readonly CueCallRow[],
  cueId: string | undefined,
  department: CueCallKind | null,
): CueCallLine[] {
  if (cueId === undefined) return [];
  return callLines(
    calls.flatMap((c) =>
      c.cue_id === cueId && isCueCallKind(c.call_kind)
        ? [{ kind: c.call_kind, instruction: c.instruction }]
        : [],
    ),
    department,
  );
}

/**
 * The department a device remembered (CompassSettings.showDepartment, in SecureStore): a value that is no
 * longer an app.cue_call_kind label reads as every department (null).
 */
export function storedDepartment(value: unknown): CueCallKind | null {
  return isCueCallKind(value) ? value : null;
}

export interface ShowState {
  readonly current: Cue | null;
  readonly next: Cue | null;
  readonly upcoming: readonly Cue[];
  readonly calledCount: number;
  readonly total: number;
  /** Milliseconds until the next cue's planned time; negative when late; null without a planned time. */
  readonly msToNext: number | null;
  /** "standby" is before the first call; the caller's standby on the next cue is `onStandby`. */
  readonly status: "standby" | "running" | "late" | "complete";
  /** True when the caller put the next cue on standby. */
  readonly onStandby: boolean;
  /** True when the next cue's time is to be confirmed: no countdown, haptic or spoken countdown for it. */
  readonly startTbc: boolean;
}

/** Seconds of warning before a cue: the haptic fires when the countdown crosses it (Section 11.13). */
export const PRE_CUE_WARNING_MS = 10_000;

export function showState(cues: readonly Cue[], nowMs: number): ShowState {
  const ordered = [...cues].sort((a, b) => a.position - b.position);
  const progress = cueProgress(
    ordered.map((c) => ({
      position: c.position,
      plannedAt: c.planned_at,
      durationSeconds: null,
      calledAt: c.called_at,
      standbyAt: c.standby_at ?? null,
      startTbc: c.start_tbc === true,
    })),
    new Date(nowMs),
  );
  const current = progress.current >= 0 ? (ordered[progress.current] ?? null) : null;
  const next = progress.next >= 0 ? (ordered[progress.next] ?? null) : null;
  const msToNext = next?.planned_at ? Date.parse(next.planned_at) - nowMs : null;
  const startTbc = next?.start_tbc === true;
  let status: ShowState["status"] = "running";
  if (progress.complete) status = "complete";
  else if (current === null) status = "standby";
  else if (msToNext !== null && msToNext < 0 && !startTbc) status = "late";
  return {
    current,
    next,
    upcoming: ordered.filter((c, i) => i > progress.next && c.called_at === null).slice(0, 3),
    calledCount: ordered.filter((c) => c.called_at !== null).length,
    total: ordered.length,
    msToNext,
    status,
    onStandby: progress.standby,
    startTbc,
  };
}

/**
 * True exactly when the countdown crosses the warning threshold between two ticks. A cue to be confirmed has no
 * firm time, so it never fires (G-40).
 */
export function preCueHapticDue(
  previousMsToNext: number | null,
  msToNext: number | null,
  nextTbc = false,
): boolean {
  if (nextTbc || previousMsToNext === null || msToNext === null) return false;
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

/** Beyond this, Today names the cue's day and time instead of counting down. */
export const COUNTDOWN_HORIZON_MS = 12 * 3600_000;

/**
 * Whether Today counts down to the next cue. A cue months away read "3547:45:52" on the simulator; past
 * the horizon the card shows when the cue is planned instead.
 */
export function showsCountdown(msToNext: number | null): msToNext is number {
  return msToNext !== null && msToNext <= COUNTDOWN_HORIZON_MS;
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
  nextTbc = false,
): number | null {
  if (nextTbc || previousMsToNext === null || msToNext === null) return null;
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
