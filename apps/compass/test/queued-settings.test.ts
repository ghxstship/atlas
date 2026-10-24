import {
  MemoryStore,
  ONLINE,
  SyncEngine,
  type Mutation,
  type MutationInput,
  type UploadOutcome,
} from "@xos/sync";
import { describe, expect, it } from "vitest";
import {
  enqueueApplying,
  resolveOverQueue,
  watchQueuedSettings,
  withQueuedSettings,
} from "../src/domain/queuedSettings";
import { hapticsOn, type ResolvedValues } from "../src/domain/settings";

/**
 * The person's own setting changes while they wait in the outbox (A65-001, me.haptics): the Haptics switch shows
 * the change from the moment it is made, through a reconnect whose resolve lands before the outbox sends it, until
 * a resolve answered after the server has it.
 */

const values = (entries: Record<string, unknown>): ResolvedValues =>
  new Map(Object.entries(entries));

const haptics = (on: boolean): MutationInput => ({
  op: "rpc",
  target: "set_personal_setting",
  table: "personal_settings",
  rowId: "me.haptics",
  payload: { p_setting_key: "me.haptics", p_value_boolean: on },
  policy: "append",
});

/** Lets the outbox reads and listeners the store started run to the end. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A promise and the functions that settle it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** An uploader that holds each upload until the test answers it. */
function heldUploader() {
  const held: { mutation: Mutation; answer: (outcome: UploadOutcome) => void }[] = [];
  return {
    held,
    uploader: {
      upload: (mutation: Mutation) =>
        new Promise<UploadOutcome>((answer) => {
          held.push({ mutation, answer });
        }),
    },
  };
}

/** The values a React state setter would hold, running each update when asked to (as React does on render). */
function lazyState(initial: ResolvedValues) {
  let current = initial;
  const queue: ((values: ResolvedValues) => ResolvedValues)[] = [];
  return {
    apply: (update: (values: ResolvedValues) => ResolvedValues) => {
      queue.push(update);
    },
    render: () => {
      for (const update of queue.splice(0)) current = update(current);
      return current;
    },
  };
}

describe("the person's queued setting changes", () => {
  it("apply before the outbox write, so the switch and the screen change render together", async () => {
    let state = values({ "me.haptics": true });
    const stored = deferred<Mutation>();
    const pending = enqueueApplying({ enqueue: () => stored.promise }, haptics(false), (update) => {
      state = update(state);
    });
    // The outbox write has not finished, and the switch already reads off.
    expect(hapticsOn(true, state)).toBe(false);
    stored.resolve({ id: "m1" } as Mutation);
    expect((await pending).id).toBe("m1");
    expect(hapticsOn(true, state)).toBe(false);
  });

  it("go back when the outbox cannot store the change, even when the update ran late", async () => {
    const state = lazyState(values({ "me.haptics": true }));
    const refused = enqueueApplying(
      { enqueue: () => Promise.reject(new Error("the local store is full")) },
      haptics(false),
      state.apply,
    );
    await expect(refused).rejects.toThrow("the local store is full");
    expect(hapticsOn(false, state.render())).toBe(true);

    // A key the values did not hold is removed again; a later change to it is kept.
    let held: ResolvedValues = values({});
    await expect(
      enqueueApplying({ enqueue: () => Promise.reject(new Error("full")) }, haptics(false), (u) => {
        held = u(held);
      }),
    ).rejects.toThrow("full");
    expect(held.has("me.haptics")).toBe(false);
    const later = lazyState(values({ "me.haptics": true }));
    const failing = deferred<Mutation>();
    const attempt = enqueueApplying(
      { enqueue: () => failing.promise },
      haptics(false),
      later.apply,
    );
    later.apply((v) => new Map(v).set("me.haptics", true));
    failing.reject(new Error("full"));
    await expect(attempt).rejects.toThrow("full");
    expect(later.render().get("me.haptics")).toBe(true);
  });

  it("lay over the resolve in queue order, the latest change to a key winning", () => {
    const queued = [
      { id: "b", seq: 2, status: "pending", ...haptics(true) },
      { id: "a", seq: 1, status: "pending", ...haptics(false) },
      {
        id: "c",
        seq: 3,
        status: "pending",
        ...haptics(false),
        payload: { p_setting_key: "me.theme", p_value_text: "dark" },
      },
      { id: "d", seq: 4, status: "conflict", ...haptics(false) },
      { id: "e", seq: 5, status: "pending", ...haptics(false), target: "clock_in" },
    ] as unknown as Mutation[];
    const resolved = values({ "me.haptics": false });
    expect(withQueuedSettings(resolved, queued).get("me.haptics")).toBe(true);
    expect(withQueuedSettings(resolved, queued).has("me.theme")).toBe(false);
    expect(withQueuedSettings(resolved, [])).toBe(resolved);
  });

  it("keep a change made offline when the reconnect's resolve lands before the outbox sends it", async () => {
    const store = new MemoryStore();
    const { held, uploader } = heldUploader();
    const engine = new SyncEngine({ store, uploader, schedule: () => () => undefined });
    let settled = 0;
    const stop = watchQueuedSettings(store, engine.outbox, () => {
      settled += 1;
    });
    let state = values({ "me.haptics": true });

    // Offline: the person turns Haptics off; the change waits in the outbox.
    await enqueueApplying(engine.outbox, haptics(false), (update) => {
      state = update(state);
    });
    expect(hapticsOn(true, state)).toBe(false);

    // Back online: the drain starts and the resolve goes out at the same time, while the server still says on.
    const drained = engine.setNetwork(ONLINE);
    await settle();
    expect(held).toHaveLength(1);
    state = (await resolveOverQueue(engine.outbox, () =>
      Promise.resolve(values({ "me.haptics": true })),
    )) as ResolvedValues;
    expect(hapticsOn(true, state)).toBe(false);

    // The outbox sends it; Compass is told to resolve again, and the server now says off.
    held[0]?.answer({ kind: "applied" });
    await drained;
    await settle();
    expect(settled).toBe(1);
    state = (await resolveOverQueue(engine.outbox, () =>
      Promise.resolve(values({ "me.haptics": false })),
    )) as ResolvedValues;
    expect(hapticsOn(true, state)).toBe(false);
    stop();
  });

  it("keep a change the outbox sends while a resolve is out, when the answer predates it", async () => {
    const store = new MemoryStore();
    const { held, uploader } = heldUploader();
    const engine = new SyncEngine({ store, uploader, schedule: () => () => undefined });
    await engine.outbox.enqueue(haptics(false));
    const answer = deferred<ResolvedValues | null>();
    const resolving = resolveOverQueue(engine.outbox, () => answer.promise);
    const drained = engine.setNetwork(ONLINE);
    await settle();
    held[0]?.answer({ kind: "applied" });
    await drained;
    expect(await engine.outbox.count()).toBe(0);
    // The server read the old value before the change reached it.
    answer.resolve(values({ "me.haptics": true }));
    expect(hapticsOn(true, (await resolving) as ResolvedValues)).toBe(false);
    // A failed resolve changes nothing.
    expect(await resolveOverQueue(engine.outbox, () => Promise.resolve(null))).toBeNull();
  });

  it("show the server's value again once the change is refused", async () => {
    const store = new MemoryStore();
    const { held, uploader } = heldUploader();
    const engine = new SyncEngine({ store, uploader, schedule: () => () => undefined });
    let settled = 0;
    const stop = watchQueuedSettings(store, engine.outbox, () => {
      settled += 1;
    });
    await engine.outbox.enqueue(haptics(false));
    await engine.outbox.enqueue({
      op: "rpc",
      target: "clock_in",
      table: "time_punches",
      rowId: "punch-1",
      payload: { p_kind: "In" },
      policy: "append",
    });
    await settle();
    const drained = engine.setNetwork(ONLINE);
    await settle();
    held[0]?.answer({ kind: "refused", error: { code: "XR001", message: "Locked." } });
    await settle();
    expect(held).toHaveLength(2);
    expect(settled).toBe(1);
    const resolved = await resolveOverQueue(engine.outbox, () =>
      Promise.resolve(values({ "me.haptics": true })),
    );
    expect(hapticsOn(false, resolved as ResolvedValues)).toBe(true);
    held[1]?.answer({ kind: "applied" });
    await drained;
    await settle();
    // Writes other than a setting Compass reads never ask for a resolve.
    expect(settled).toBe(1);
    stop();
    await engine.outbox.enqueue(haptics(false));
    await settle();
    expect(settled).toBe(1);
  });
});
