/**
 * Keeps the iOS clock Live Activity in step with the clock, and drains punches made from it (SIM-005,
 * journey 52). Where Live Activities are unavailable (Android, older iOS, the person turned them off) the
 * native module is null or reports unsupported, and the in-app Live Activity card on Today is the clock.
 */
import type { MutationInput } from "@xos/sync";
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { CompassLiveActivity, type ClockLabels } from "../../modules/compass-live-activity";
import type { ClockSnapshot, PunchContext } from "../domain/clock";
import {
  activityChanged,
  activityContent,
  queuedPunchMutation,
  serializeContext,
  type ActivityContent,
  type QueuedPunch,
} from "../domain/liveActivity";
import { deviceClock } from "./platform";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Starts the activity at clock in, updates it for a break, ends it at clock out. Returns the reason the
 * last native call failed, for Today to say the lock screen activity is not running, or null.
 */
export function useClockLiveActivity(
  snapshot: ClockSnapshot,
  context: PunchContext | null,
  labels: ClockLabels,
): string | null {
  const shown = useRef<ActivityContent | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const next = activityContent(snapshot, Date.now());
  const contextJson = context ? serializeContext(context) : null;
  const labelsJson = JSON.stringify(labels);
  // One value key: the effect reruns only when what the activity shows, or its context, changes.
  const key = JSON.stringify([next, contextJson, labelsJson]);
  useEffect(() => {
    const native = CompassLiveActivity;
    const [content, ctx, labelText] = JSON.parse(key) as [
      ActivityContent | null,
      string | null,
      string,
    ];
    if (!native || !activityChanged(shown.current, content)) return;
    const previous = shown.current;
    // Starting needs the punch context the lock screen buttons will use; wait until scope has loaded.
    if (previous === null && content !== null && ctx === null) return;
    shown.current = content;
    const run = async () => {
      if (!native.isSupported()) return;
      if (content === null) await native.end();
      else if (previous === null && ctx !== null)
        await native.start(JSON.parse(labelText) as ClockLabels, content, ctx);
      else await native.update(content);
    };
    run().then(
      () => setFailure(null),
      (error: unknown) => {
        shown.current = previous;
        setFailure(message(error));
      },
    );
  }, [key]);
  return failure;
}

export interface DrainProblem {
  /** The native or outbox error, when the drain failed. */
  readonly error: string | null;
  /** Punches dropped because the activity was started without a punch context. */
  readonly dropped: number;
}

/**
 * Moves punches queued from the lock screen into the sync outbox: at start, whenever Compass comes to the
 * front, and when the intent says it queued one while Compass runs. Each is acknowledged only after it is
 * in the outbox, so a crash in between replays it under the same punch id.
 */
export function useLockScreenPunchDrain(
  enqueue: ((input: MutationInput) => Promise<string>) | null,
): DrainProblem | null {
  const [failure, setFailure] = useState<DrainProblem | null>(null);
  useEffect(() => {
    const native = CompassLiveActivity;
    if (!native || !enqueue) return undefined;
    let draining = false;
    const drain = async () => {
      if (draining) return;
      draining = true;
      try {
        const done: string[] = [];
        let dropped = 0;
        for (const item of native.peekQueue()) {
          const mutation = queuedPunchMutation(item as QueuedPunch, deviceClock);
          if (mutation) await enqueue(mutation);
          else dropped += 1;
          done.push(item.id);
        }
        if (done.length > 0) native.ackQueue(done);
        setFailure(dropped > 0 ? { error: null, dropped } : null);
      } catch (error: unknown) {
        setFailure({ error: message(error), dropped: 0 });
      } finally {
        draining = false;
      }
    };
    void drain();
    const queued = native.addListener("onPunchQueued", () => void drain());
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") void drain();
    });
    return () => {
      queued.remove();
      appState.remove();
    };
  }, [enqueue]);
  return failure;
}
