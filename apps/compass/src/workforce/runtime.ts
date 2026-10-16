/**
 * The Compass side of the Workforce screens (@xos/workforce-native): reads through A29's repositories with
 * the person's own client, so row level security decides; offline writes through the queue (writes.ts);
 * online-only writes through the repositories, with refusals in the person's language.
 */
import type { XosClient } from "@xos/data/client";
import type { Result } from "@xos/data/result";
import type { ActionResult, ScreenStatus } from "@xos/workforce-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { useCompass } from "../runtime/CompassProvider";
import { toAction } from "./messages";
import { workforceWrite, type WorkforceSyncRpc } from "./writes";

export { actionMessage, toAction } from "./messages";

export interface WorkforceContext {
  readonly db: XosClient;
  readonly orgId: string | null;
  readonly projectId: string | null;
  readonly personId: string | null;
  readonly displayName: string;
  readonly myMembershipIds: readonly string[];
  /** Queues one allowlisted RPC; the queue uploads it now or when back online. */
  readonly queue: (
    rpc: WorkforceSyncRpc,
    args: Readonly<Record<string, unknown>>,
  ) => Promise<ActionResult>;
  /** Runs a write that needs the server's answer now. */
  readonly online: (call: Promise<Result<unknown>>) => Promise<ActionResult>;
  /** Changes whenever the queue finished an upload, so screens read the server's rows again. */
  readonly syncTick: number | null;
}

export function useWorkforce(t: (key: string) => string): WorkforceContext {
  const { client, resolved, projectId, enqueue, status } = useCompass();
  const identity = resolved?.identity ?? null;
  const queue = useCallback(
    async (
      rpc: WorkforceSyncRpc,
      args: Readonly<Record<string, unknown>>,
    ): Promise<ActionResult> => {
      try {
        await enqueue(workforceWrite(rpc, args, Date.now()));
        return { ok: true };
      } catch (error) {
        console.error("Workforce write could not be queued", error);
        return { ok: false, message: t("workforce.compass.common.unexpected") };
      }
    },
    [enqueue, t],
  );
  const online = useCallback(
    async (call: Promise<Result<unknown>>): Promise<ActionResult> => toAction(await call, t),
    [t],
  );
  return {
    db: client as unknown as XosClient,
    orgId: resolved?.orgId ?? null,
    projectId,
    personId: identity?.personId ?? null,
    displayName: identity?.displayName ?? "",
    myMembershipIds: identity?.membershipId ? [identity.membershipId] : [],
    queue,
    online,
    syncTick: status?.lastDrainAt ?? null,
  };
}

export interface Loaded<T> {
  readonly status: ScreenStatus;
  readonly data: T | null;
  readonly refreshing: boolean;
  readonly refresh: () => void;
  readonly errorReference: string | undefined;
}

/**
 * Loads a screen's data and reloads it on refresh and after every upload. A load of null (no org or
 * project chosen yet) stays loading; a failed read shows the retry state, never an empty list.
 */
export function useLoad<T>(
  load: (() => Promise<Result<T>>) | null,
  deps: readonly unknown[],
): Loaded<T> {
  const [state, setState] = useState<{ status: ScreenStatus; data: T | null; error?: string }>({
    status: "loading",
    data: null,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    const run = loader.current;
    if (!run) return undefined;
    let live = true;
    run().then(
      (result) => {
        if (!live) return;
        setRefreshing(false);
        if (result.ok) setState({ status: "ready", data: result.data });
        else {
          console.error("Workforce read failed", result.error);
          setState((s) => ({
            status: s.data === null ? "error" : "ready",
            data: s.data,
            error: result.error.kind,
          }));
        }
      },
      (error: unknown) => {
        if (!live) return;
        console.error("Workforce read failed", error);
        setRefreshing(false);
        setState((s) => ({
          status: s.data === null ? "error" : "ready",
          data: s.data,
          error: "unexpected",
        }));
      },
    );
    return () => {
      live = false;
    };
  }, [...deps, tick, load === null]);
  return {
    status: state.status,
    data: state.data,
    refreshing,
    refresh: () => {
      setRefreshing(true);
      setTick((n) => n + 1);
    },
    errorReference: state.error,
  };
}
