/**
 * Show timing (Section 4.2 Show, Section 4.3 item 9; ADR 0131): where a running order stands and how the show runs
 * against its plan, derived from the cue rows and never stored (ADR 0103). Atlas's showcaller console and live mode,
 * Compass Show and Today compute the same current, next, standby, skipped and complete from the same rows, so this
 * file holds pure functions with no imports.
 */

/** The cue fields timing reads. Times are ISO 8601 instants. */
export interface TimedCue {
  readonly position: number;
  readonly plannedAt: string | null;
  /** Planned length in seconds; NULL when not set. */
  readonly durationSeconds: number | null;
  readonly calledAt: string | null;
  /** When the caller put the cue on standby; the standby cue is the uncalled cue with a standby time. */
  readonly standbyAt?: string | null;
  /** True while the planned time is an estimate to be confirmed. */
  readonly startTbc?: boolean;
}

export interface CueProgress {
  /** Index of the most recently called cue (by call time, ties to the later position), or -1 before the first call. */
  readonly current: number;
  /**
   * Index of the next cue to call: the standby cue, else the first uncalled cue after the latest called position,
   * else the first uncalled cue; -1 when every cue is called.
   */
  readonly next: number;
  /** Seconds until the next cue's planned time, negative when it is late; NULL without a plan. */
  readonly nextInSeconds: number | null;
  /** Seconds the current cue has run. */
  readonly elapsedSeconds: number | null;
  /** True when no uncalled cue follows the latest called position and no uncalled cue is on standby. */
  readonly complete: boolean;
  /** True when `next` is the cue the caller put on standby. */
  readonly standby: boolean;
  /** Indices of uncalled cues before the latest called position: the caller jumped past them. */
  readonly skipped: readonly number[];
}

/** Indices are into the cues ordered by position; the function orders them itself. */
function ordered<T extends TimedCue>(cues: readonly T[]): T[] {
  return [...cues].sort((a, b) => a.position - b.position);
}

/** Where a running order stands at `now`. Indices refer to the cues in position order. */
export function cueProgress(cues: readonly TimedCue[], now: Date = new Date()): CueProgress {
  const list = ordered(cues);
  const nowMs = now.getTime();
  let current = -1;
  let highest = -1;
  list.forEach((c, i) => {
    if (c.calledAt === null) return;
    highest = i;
    const best = current >= 0 ? list[current] : undefined;
    const at = Date.parse(c.calledAt);
    if (!best || at >= Date.parse(best.calledAt ?? "")) current = i;
  });
  const uncalled = (i: number) => list[i]?.calledAt === null;
  const standbyIndex = list.findIndex((c) => c.calledAt === null && Boolean(c.standbyAt));
  const after = list.findIndex((c, i) => i > highest && c.calledAt === null);
  const next =
    standbyIndex >= 0
      ? standbyIndex
      : after >= 0
        ? after
        : list.findIndex((c) => c.calledAt === null);
  const skipped = list.map((_, i) => i).filter((i) => i < highest && uncalled(i));
  const nextCue = next >= 0 ? list[next] : undefined;
  const currentCue = current >= 0 ? list[current] : undefined;
  return {
    current,
    next,
    nextInSeconds: nextCue?.plannedAt
      ? Math.round((Date.parse(nextCue.plannedAt) - nowMs) / 1000)
      : null,
    elapsedSeconds: currentCue?.calledAt
      ? Math.round((nowMs - Date.parse(currentCue.calledAt)) / 1000)
      : null,
    complete: list.length > 0 && after === -1 && highest >= 0 && standbyIndex === -1,
    standby: standbyIndex >= 0,
    skipped,
  };
}

/** The projected end within this many seconds of the curfew is near (ADR 0131 decision 5). */
export const CURFEW_WARNING_SECONDS = 600;

export type CurfewRisk = "none" | "ok" | "near" | "over";

export interface ShowClock {
  /** The first call: when the show started; NULL before it. */
  readonly startedAt: string | null;
  /** Seconds since the first call, frozen at the last call once the show is complete; NULL before it starts. */
  readonly elapsedSeconds: number | null;
  /**
   * Seconds behind the plan (negative when ahead): the larger of the latest called planned cue's lateness and how far
   * past its plan the next cue is. A cue to be confirmed has no firm plan and counts for neither. NULL when no cue has
   * a firm plan.
   */
  readonly overrunSeconds: number | null;
  /** The last cue's planned time plus its length; NULL when it has no plan. */
  readonly plannedEndAt: string | null;
  /** The planned end moved by the overrun. */
  readonly projectedEndAt: string | null;
  readonly curfewRisk: CurfewRisk;
  /** Seconds from the projected end to the curfew, negative past it; NULL without both. */
  readonly curfewMarginSeconds: number | null;
}

/** How the show runs against its plan and its curfew at `now`. */
export function showClock(
  cues: readonly TimedCue[],
  run: { readonly curfewAt: string | null },
  now: Date = new Date(),
): ShowClock {
  const list = ordered(cues);
  const nowMs = now.getTime();
  const progress = cueProgress(list, now);
  const calls = list
    .filter((c) => c.calledAt !== null)
    .map((c) => Date.parse(c.calledAt ?? ""))
    .sort((a, b) => a - b);
  const first = calls[0];
  const last = calls.at(-1);
  const elapsedSeconds =
    first === undefined
      ? null
      : Math.round(((progress.complete && last !== undefined ? last : nowMs) - first) / 1000);

  const firm = (c: TimedCue | undefined): c is TimedCue & { plannedAt: string } =>
    c !== undefined && c.plannedAt !== null && !c.startTbc;
  const terms: number[] = [];
  const latestPlanned = list
    .filter((c) => c.calledAt !== null && firm(c))
    .sort(
      (a, b) =>
        Date.parse(b.calledAt ?? "") - Date.parse(a.calledAt ?? "") || b.position - a.position,
    )[0];
  if (firm(latestPlanned)) {
    terms.push(
      (Date.parse(latestPlanned.calledAt ?? "") - Date.parse(latestPlanned.plannedAt)) / 1000,
    );
  }
  const nextCue = progress.next >= 0 ? list[progress.next] : undefined;
  if (!progress.complete && firm(nextCue) && nowMs > Date.parse(nextCue.plannedAt)) {
    terms.push((nowMs - Date.parse(nextCue.plannedAt)) / 1000);
  }
  const hasPlan = list.some((c) => firm(c));
  const overrunSeconds = !hasPlan ? null : terms.length === 0 ? 0 : Math.round(Math.max(...terms));

  const end = list.at(-1);
  const plannedEndMs = end?.plannedAt
    ? Date.parse(end.plannedAt) + (end.durationSeconds ?? 0) * 1000
    : null;
  const projectedEndMs = plannedEndMs === null ? null : plannedEndMs + (overrunSeconds ?? 0) * 1000;
  const curfewMs = run.curfewAt ? Date.parse(run.curfewAt) : null;
  const curfewMarginSeconds =
    curfewMs === null || projectedEndMs === null
      ? null
      : Math.round((curfewMs - projectedEndMs) / 1000);
  const curfewRisk: CurfewRisk =
    curfewMarginSeconds === null
      ? "none"
      : curfewMarginSeconds < 0
        ? "over"
        : curfewMarginSeconds <= CURFEW_WARNING_SECONDS
          ? "near"
          : "ok";
  return {
    startedAt: first === undefined ? null : new Date(first).toISOString(),
    elapsedSeconds,
    overrunSeconds,
    plannedEndAt: plannedEndMs === null ? null : new Date(plannedEndMs).toISOString(),
    projectedEndAt: projectedEndMs === null ? null : new Date(projectedEndMs).toISOString(),
    curfewRisk,
    curfewMarginSeconds,
  };
}
