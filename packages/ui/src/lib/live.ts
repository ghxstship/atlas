import { createContext, createElement, useContext, useEffect, useRef, type ReactNode } from "react";

/**
 * Live updates in React (Section 11.7, ADR 0044). Components say which tables they show with
 * `useLive`; the app's `LiveProvider` supplies the source, a hub that keeps one Realtime channel per
 * page (`@xos/data/live`). This module has no Realtime code of its own, so a page that never
 * watches anything never loads it, and outside a provider (Storybook, tests) `useLive` does nothing.
 */

/** One watched table, optionally narrowed with a Realtime filter such as `org_id=eq.<uuid>`. */
export interface LiveTopic {
  readonly table: string;
  readonly filter?: string;
}

/** A changed row, or `RESYNC` after a reconnect. */
export interface LiveChange {
  readonly table: string;
  readonly type: "INSERT" | "UPDATE" | "DELETE" | "RESYNC";
  readonly id: string | null;
}

/** How fast batches may arrive; show mode follows cues faster than a list follows rows. */
export interface LivePacing {
  readonly batchMs?: number;
  readonly minIntervalMs?: number;
  readonly maxIntervalMs?: number;
}

export interface LiveSource {
  watch(
    topics: readonly LiveTopic[],
    listener: (changes: readonly LiveChange[]) => void,
    pacing?: LivePacing,
  ): () => void;
}

const LiveContext = createContext<LiveSource | null>(null);

export function LiveProvider({
  source,
  children,
}: {
  source: LiveSource | null;
  children?: ReactNode;
}): ReactNode {
  return createElement(LiveContext.Provider, { value: source }, children);
}

/** The topics as a stable key, so a new array with the same topics never resubscribes. */
function topicsKey(topics: readonly LiveTopic[] | null): string {
  if (!topics || topics.length === 0) return "";
  return topics
    .map((t) => `${t.table}|${t.filter ?? ""}`)
    .sort()
    .join(",");
}

/**
 * Calls `onChange` with each batch of changes to the topics while the component is mounted. Null or
 * empty topics watch nothing. The latest `onChange` is always the one called.
 */
export function useLive(
  topics: readonly LiveTopic[] | null,
  onChange: (changes: readonly LiveChange[]) => void,
  pacing?: LivePacing,
): void {
  const source = useContext(LiveContext);
  const handler = useRef(onChange);
  handler.current = onChange;
  const key = topicsKey(topics);
  const batchMs = pacing?.batchMs;
  const minIntervalMs = pacing?.minIntervalMs;
  const maxIntervalMs = pacing?.maxIntervalMs;
  useEffect(() => {
    if (!source || key === "") return undefined;
    const watched = key.split(",").map((k): LiveTopic => {
      const [table = "", filter = ""] = k.split("|");
      return filter ? { table, filter } : { table };
    });
    return source.watch(watched, (changes) => handler.current(changes), {
      ...(batchMs !== undefined ? { batchMs } : {}),
      ...(minIntervalMs !== undefined ? { minIntervalMs } : {}),
      ...(maxIntervalMs !== undefined ? { maxIntervalMs } : {}),
    });
  }, [source, key, batchMs, minIntervalMs, maxIntervalMs]);
}
