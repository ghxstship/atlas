/**
 * What a Gateway list watches live (Section 11.7, ADR 0082). Published tables are watched with a
 * Realtime filter narrowed to the person or to the engagements the page shows; row level security
 * still decides each change. Engagements, invoices and payments are not published to external
 * people: their changes arrive as pings on the person's private channel instead.
 */

export interface GatewayTopic {
  readonly table: string;
  readonly filter?: string;
}

/** Realtime takes at most 100 values in an `in` filter, and a filter's length is bounded. */
const MAX_IDS = 40;

/**
 * A topic narrowed to rows whose `column` is one of `ids`. With no ids there is nothing to watch;
 * with more than fit in one filter the topic goes unfiltered, and row level security alone
 * confines it to the person's rows.
 */
export function idsTopic(
  table: string,
  column: string,
  ids: readonly (string | null | undefined)[],
): GatewayTopic | null {
  const unique = [
    ...new Set(ids.filter((id): id is string => typeof id === "string" && id !== "")),
  ];
  if (unique.length === 0) return null;
  if (unique.length > MAX_IDS) return { table };
  return { table, filter: `${column}=in.(${unique.join(",")})` };
}

/** A topic narrowed to the person's own rows of a table. */
export function personTopic(table: string, column: string, personId: string): GatewayTopic {
  return { table, filter: `${column}=eq.${personId}` };
}

/** The topics a page watches, without the ones that had nothing to watch. */
export function topics(...list: readonly (GatewayTopic | null)[]): GatewayTopic[] {
  return list.filter((t): t is GatewayTopic => t !== null);
}

/** The person's private channel, which only they may join (migration 2161's channel rule). */
export function personalChannel(personId: string): string {
  return `gateway:${personId}`;
}

/** Timers, injectable for tests. */
export interface PacerClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * Paces rereads caused by channel pings as the live hub paces its batches: pings gather for
 * `batchMs`, and rereads come at most every `minIntervalMs`, so a burst of changes rereads once.
 */
export function createPacer(
  run: () => void,
  options: {
    readonly batchMs?: number;
    readonly minIntervalMs?: number;
    readonly clock?: PacerClock;
  } = {},
): { readonly ping: () => void; readonly stop: () => void } {
  const batchMs = options.batchMs ?? 300;
  const minInterval = options.minIntervalMs ?? 2_000;
  const clock: PacerClock = options.clock ?? {
    now: () => Date.now(),
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  let timer: unknown = null;
  let last = Number.NEGATIVE_INFINITY;
  let stopped = false;
  const fire = () => {
    timer = null;
    if (stopped) return;
    const wait = last + minInterval - clock.now();
    if (wait > 0) {
      timer = clock.setTimeout(fire, wait);
      return;
    }
    last = clock.now();
    run();
  };
  return {
    ping() {
      if (stopped || timer !== null) return;
      timer = clock.setTimeout(fire, batchMs);
    },
    stop() {
      stopped = true;
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
    },
  };
}
