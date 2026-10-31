/**
 * The rules of a drafted list (P6, parity gap G-83): what Aurora may draft into an empty running
 * order or risk list, how many lines, and the gaps and clashes check a run of show gets. The check
 * is deterministic code, never the model: the server runs it on the draft and the Atlas panel runs
 * it again on every edit. No zod and no model code, so the panel can import it.
 */

export const LIST_DRAFT_KINDS = ["run_of_show", "risk_assessment"] as const;
export type ListDraftKind = (typeof LIST_DRAFT_KINDS)[number];

export function isListDraftKind(kind: string): kind is ListDraftKind {
  return (LIST_DRAFT_KINDS as readonly string[]).includes(kind);
}

/** The most cues one draft proposes: what one tool call fits within the drafting token limit. */
export const MAX_CUES = 60;
/** The most risks one draft proposes. */
export const MAX_RISKS = 40;
/** Idle time between one cue's end and the next start, in minutes, above which a gap is flagged. */
export const GAP_MINUTES = 30;
/** The latest local time on the day after the show a cue may fall at (a show that runs late). */
export const LATEST_AFTER_MIDNIGHT = "06:00";

/** One cue as the check reads it: its place, its planned instant and its length. */
export interface RunOfShowLine {
  readonly position: number;
  /** ISO 8601 instant, or null for an untimed cue. */
  readonly plannedAt: string | null;
  readonly durationSeconds: number | null;
}

export interface RunOfShowFlag {
  readonly type: "overlap" | "gap" | "untimed" | "out_of_order";
  /** The cue or the pair of cues the flag is about. */
  readonly positions: readonly number[];
  /** For an overlap, how far the first cue runs into the next; for a gap, the idle time. */
  readonly minutes?: number;
}

/**
 * Gaps and clashes in a running order, in position order. Untimed cues are flagged and skipped, so
 * each timed cue is compared with the next timed one: out of order when the time goes back, an
 * overlap when the first cue's planned end passes the next start, and a gap when the idle time
 * between them exceeds GAP_MINUTES. A cue without a duration ends where it starts: it is measured
 * for gaps and never overlaps.
 */
export function checkRunOfShow(items: readonly RunOfShowLine[]): RunOfShowFlag[] {
  const flags: RunOfShowFlag[] = [];
  const sorted = [...items].sort((a, b) => a.position - b.position);
  let previous: { position: number; start: number; durationSeconds: number | null } | null = null;
  for (const item of sorted) {
    const start = item.plannedAt === null ? Number.NaN : Date.parse(item.plannedAt);
    if (Number.isNaN(start)) {
      flags.push({ type: "untimed", positions: [item.position] });
      continue;
    }
    if (previous) {
      const pair = [previous.position, item.position];
      if (start < previous.start) {
        flags.push({ type: "out_of_order", positions: pair });
      } else {
        const end = previous.start + (previous.durationSeconds ?? 0) * 1000;
        if (previous.durationSeconds !== null && end > start) {
          flags.push({
            type: "overlap",
            positions: pair,
            minutes: Math.ceil((end - start) / 60_000),
          });
        } else if (start - end > GAP_MINUTES * 60_000) {
          flags.push({ type: "gap", positions: pair, minutes: Math.round((start - end) / 60_000) });
        }
      }
    }
    previous = { position: item.position, start, durationSeconds: item.durationSeconds };
  }
  return flags;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** How far the zone's wall clock is ahead of UTC at an instant, in milliseconds. */
function offsetAt(at: number, zone: string): number {
  let format = formatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, format);
  }
  const parts = format.formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wall = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return wall - at;
}

/** The day after a YYYY-MM-DD day, on the calendar. */
export function nextDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * The instant a wall-clock time on a day names in a time zone, as ISO 8601 UTC, or null when the
 * day or time is malformed. Across a daylight saving change it reads like a calendar does: a time
 * that occurs twice is its first occurrence, and a time the clocks skip lands as far after the change
 * as it was written past the hour (02:30 on a spring-forward day is 03:30).
 */
export function zonedInstant(day: string, time: string, zone: string): string | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const t = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!d || !t) return null;
  const local = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  const before = offsetAt(local - 86_400_000, zone);
  const after = offsetAt(local + 86_400_000, zone);
  if (before === after) return new Date(local - before).toISOString();
  const valid = [local - before, local - after].filter((at) => at + offsetAt(at, zone) === local);
  return new Date(valid.length > 0 ? Math.min(...valid) : local - before).toISOString();
}

/** A duration in whole minutes as the cue column takes it, HH:MM:SS. */
export function durationText(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
}

/** Seconds of an HH:MM:SS duration, or null when it is empty or malformed. */
export function durationSeconds(text: string | null): number | null {
  if (text === null) return null;
  const match = /^(\d{1,2}):([0-5]\d):([0-5]\d)$/.exec(text);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}
