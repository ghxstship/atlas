import type { TimelineChange, TimelineLink, TimelineMove } from "../types/reference";

/** A bar's first and last day, by day index (the last day inclusive). */
interface Span {
  readonly start: number;
  readonly end: number;
}

/** The dependency preview of a pending change, worked out on the day grid. */
export interface TimelinePlan {
  /** Rows other than the changed one that the change pushes, with their new days. */
  readonly moves: readonly TimelineMove[];
  /** Rows the change would move that are locked, the changed row first. */
  readonly locked: readonly number[];
  /** Rows on the critical path before and after the change. */
  readonly criticalBefore: readonly number[];
  readonly criticalAfter: readonly number[];
  /** Days the last finish moves (negative for earlier). */
  readonly finishShift: number;
}

const EPSILON = 1e-9;

/*
 * Bars occupy half-open day ranges [start, end + 1), so a Finish to Start successor may start the
 * day after its predecessor's last day. Each type compares one side of each bar:
 * the predecessor's start or finish, plus lag, against the successor's start or finish.
 */
function gap(link: TimelineLink, from: Span, to: Span): number {
  const type = link.type ?? "Finish to Start";
  const fromFinish = type === "Finish to Start" || type === "Finish to Finish";
  const toStart = type === "Finish to Start" || type === "Start to Start";
  const required = (fromFinish ? from.end + 1 : from.start) + (link.lagDays ?? 0);
  const actual = toStart ? to.start : to.end + 1;
  return required - actual;
}

/** True when a dependency path from the row comes back to a row already on it. */
function cyclic(links: readonly TimelineLink[], row: number): boolean {
  const out = new Map<number, number[]>();
  for (const l of links) out.set(l.from, [...(out.get(l.from) ?? []), l.to]);
  const done = new Set<number>();
  const path = new Set<number>();
  const visit = (i: number): boolean => {
    if (path.has(i)) return true;
    if (done.has(i)) return false;
    path.add(i);
    const found = (out.get(i) ?? []).some(visit);
    path.delete(i);
    done.add(i);
    return found;
  };
  return visit(row);
}

/**
 * Pushes the successors of a changed row by the whole days their dependencies need, round by round
 * through the chain, as app.reschedule_record does on the server (ADR 0111): a successor moves only
 * by what the change adds to its dependency's gap, so a gap already broken stays as it was and
 * moving a row earlier pulls nothing. Returns null for a cycle.
 */
export function pushSuccessors(
  spans: readonly Span[],
  links: readonly TimelineLink[],
  change: TimelineChange,
): Span[] | null {
  if (cyclic(links, change.row)) return null;
  const now: Span[] = spans.map((s) => ({ start: s.start, end: s.end }));
  now[change.row] = { start: change.start, end: change.end };
  const allowed = links.map((l) => {
    const from = spans[l.from];
    const to = spans[l.to];
    return from && to ? Math.max(0, gap(l, from, to)) : 0;
  });
  const moved = (i: number) => now[i]?.start !== spans[i]?.start || now[i]?.end !== spans[i]?.end;
  for (let round = 0; round <= spans.length; round += 1) {
    const push = new Map<number, number>();
    links.forEach((l, k) => {
      const from = now[l.from];
      const to = now[l.to];
      if (!from || !to || l.to === change.row || !moved(l.from)) return;
      const need = gap(l, from, to) - (allowed[k] ?? 0);
      if (need > EPSILON) push.set(l.to, Math.max(push.get(l.to) ?? 0, Math.ceil(need - EPSILON)));
    });
    if (push.size === 0) return now;
    for (const [i, days] of push) {
      const s = now[i];
      if (s) now[i] = { start: s.start + days, end: s.end + days };
    }
  }
  return null;
}

/**
 * Rows with no float: those whose slip, followed through their successors' slack, moves the last
 * finish. A row with no successor has the days between its finish and the last finish as float.
 */
export function criticalRows(spans: readonly Span[], links: readonly TimelineLink[]): number[] {
  if (spans.length === 0) return [];
  const finish = Math.max(...spans.map((s) => s.end + 1));
  const out = new Map<number, TimelineLink[]>();
  for (const l of links) out.set(l.from, [...(out.get(l.from) ?? []), l]);
  const memo = new Map<number, number>();
  const visiting = new Set<number>();
  const float = (i: number): number => {
    const known = memo.get(i);
    if (known !== undefined) return known;
    const s = spans[i];
    if (!s || visiting.has(i)) return Number.POSITIVE_INFINITY;
    visiting.add(i);
    let value = finish - (s.end + 1);
    for (const l of out.get(i) ?? []) {
      const to = spans[l.to];
      if (to) value = Math.min(value, -gap(l, s, to) + float(l.to));
    }
    visiting.delete(i);
    memo.set(i, value);
    return value;
  };
  return spans.flatMap((_, i) => (float(i) <= EPSILON ? [i] : []));
}

/** The preview of one change: the rows it pushes, the locked rows it would move, and the critical path. */
export function planChange(
  spans: readonly Span[],
  links: readonly TimelineLink[],
  change: TimelineChange,
  isLocked: (row: number) => boolean,
): TimelinePlan | null {
  const after = pushSuccessors(spans, links, change);
  if (!after) return null;
  const moves: TimelineMove[] = [];
  after.forEach((s, i) => {
    const was = spans[i];
    if (i !== change.row && was && (s.start !== was.start || s.end !== was.end)) {
      moves.push({ row: i, start: s.start, end: s.end });
    }
  });
  return withMoves(spans, links, change, moves, isLocked);
}

/** The preview of a change whose pushed rows are already known (the page's own preview). */
export function withMoves(
  spans: readonly Span[],
  links: readonly TimelineLink[],
  change: TimelineChange,
  moves: readonly TimelineMove[],
  isLocked: (row: number) => boolean,
): TimelinePlan {
  const after = spans.map((s) => ({ start: s.start, end: s.end }));
  after[change.row] = { start: change.start, end: change.end };
  for (const m of moves) after[m.row] = { start: m.start, end: m.end };
  const was = spans[change.row];
  const targetMoved = !!was && (was.start !== change.start || was.end !== change.end);
  const lastFinish = (list: readonly Span[]) => Math.max(...list.map((s) => s.end + 1));
  return {
    moves,
    locked: [
      ...(targetMoved && isLocked(change.row) ? [change.row] : []),
      ...moves.filter((m) => isLocked(m.row)).map((m) => m.row),
    ],
    criticalBefore: criticalRows(spans, links),
    criticalAfter: criticalRows(after, links),
    finishShift: spans.length > 0 ? lastFinish(after) - lastFinish(spans) : 0,
  };
}

/** Same rows in both lists, in any order. */
export function sameRows(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((i) => set.has(i));
}
