/**
 * The person's own setting changes while they wait in the outbox (A65-001). Compass shows a personal setting it
 * reads, such as Haptics (me.haptics), from the resolved values, so a change made on this device has to stay in
 * those values from the moment the person makes it until a resolve that the server answered after the change
 * reached it. Three rules keep it there:
 *
 *   1. enqueueApplying applies the change before the outbox write, in the same turn as the screen's own state
 *      change, so a switch never renders its old value in between.
 *   2. resolveOverQueue lays every queued change over a fresh resolve, including one the outbox sent while the
 *      request was out, so an answer that predates the change never replaces it.
 *   3. watchQueuedSettings reports when a queued change leaves the queue (sent, refused or discarded), so Compass
 *      resolves again and shows what the server now holds.
 */
import { OUTBOX_TABLE, type LocalStore, type Mutation, type MutationInput } from "@xos/sync";
import {
  COMPASS_SETTING_KEYS,
  PERSONAL_SETTING_RPCS,
  withQueuedSetting,
  type ResolvedValues,
} from "./settings";

/** The part of the outbox these rules read. */
export interface QueuedOutbox {
  all(): Promise<readonly Mutation[]>;
}

/** True for a set_personal_setting or clear_personal_setting waiting to be sent for a key Compass reads. */
function isQueuedSetting(mutation: Mutation): boolean {
  const key = mutation.payload["p_setting_key"];
  return (
    mutation.status === "pending" &&
    mutation.op === "rpc" &&
    PERSONAL_SETTING_RPCS.includes(mutation.target) &&
    typeof key === "string" &&
    COMPASS_SETTING_KEYS.includes(key)
  );
}

/** The values with every queued setting laid over them in queue order, so the latest change to a key wins. */
export function withQueuedSettings(
  values: ResolvedValues,
  mutations: readonly Mutation[],
): ResolvedValues {
  return mutations
    .filter(isQueuedSetting)
    .sort((a, b) => a.seq - b.seq)
    .reduce<ResolvedValues>((next, mutation) => withQueuedSetting(next, mutation), values);
}

/**
 * Queues a write. A personal setting Compass reads applies to the values first, before the outbox write is
 * awaited, so the caller's state change and this one render together. When the outbox cannot store the write,
 * the value goes back to what it was, unless something changed it since. `apply` takes an update of the values,
 * as React's state setter does, and may run it later, in order.
 */
export async function enqueueApplying(
  outbox: { enqueue(input: MutationInput): Promise<Mutation> },
  input: MutationInput,
  apply: (update: (values: ResolvedValues) => ResolvedValues) => void,
): Promise<Mutation> {
  const key = input.payload["p_setting_key"];
  /** What the key held before the change, and the value the change gave it. */
  const undo: { before?: { readonly had: boolean; readonly value: unknown }; queued?: unknown } =
    {};
  apply((values) => {
    const next = withQueuedSetting(values, input);
    if (next !== values && typeof key === "string") {
      undo.before = { had: values.has(key), value: values.get(key) };
      undo.queued = next.get(key);
    }
    return next;
  });
  try {
    return await outbox.enqueue(input);
  } catch (error) {
    // Read inside the update: React may run the first one only when it renders, still before this one.
    apply((values) => {
      const before = undo.before;
      if (before === undefined || typeof key !== "string" || values.get(key) !== undo.queued) {
        return values;
      }
      const next = new Map(values);
      if (before.had) next.set(key, before.value);
      else next.delete(key);
      return next;
    });
    throw error;
  }
}

/**
 * Resolves the settings and lays the person's queued changes over the answer: those still queued, and those
 * queued when the request left that have since left the queue, whose sending the answer may predate. Returns
 * null when the resolve failed.
 */
export async function resolveOverQueue(
  outbox: QueuedOutbox,
  resolve: () => Promise<ResolvedValues | null>,
): Promise<ResolvedValues | null> {
  const before = (await outbox.all()).filter(isQueuedSetting);
  const fresh = await resolve();
  if (fresh === null) return null;
  const after = await outbox.all();
  const present = new Set(after.map((m) => m.id));
  return withQueuedSettings(fresh, [...before.filter((m) => !present.has(m.id)), ...after]);
}

/**
 * Calls onSettled whenever a queued setting leaves the queue or stops waiting (sent, refused into the resolution
 * sheet, or discarded), so Compass resolves again. Reads of the outbox run one at a time, so a slow read never
 * reports an older queue after a newer one. Returns the function that stops watching.
 */
export function watchQueuedSettings(
  store: Pick<LocalStore, "subscribe">,
  outbox: QueuedOutbox,
  onSettled: () => void,
): () => void {
  let live = true;
  let waiting = new Set<string>();
  let reads: Promise<void> = Promise.resolve();
  const check = () => {
    reads = reads
      .then(async () => {
        const now = new Set((await outbox.all()).filter(isQueuedSetting).map((m) => m.id));
        const settled = [...waiting].some((id) => !now.has(id));
        waiting = now;
        if (live && settled) onSettled();
      })
      // A failed read leaves the last queue in place; the next change reads again.
      .catch(() => undefined);
  };
  check();
  const stop = store.subscribe((table) => {
    if (table === OUTBOX_TABLE) check();
  });
  return () => {
    live = false;
    stop();
  };
}
