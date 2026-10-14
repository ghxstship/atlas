import { describe, expect, it } from "vitest";
import {
  anchorFromServer,
  classifyServerError,
  defaultPolicy,
  isUuidv7,
  MemoryStore,
  mergeFields,
  needsReview,
  nextReady,
  recordKey,
  sameValue,
  stampEvent,
  uuidv7,
  uuidv7Time,
  type DeviceClock,
  type Mutation,
} from "../src";

describe("uuidv7", () => {
  it("encodes the timestamp, version and variant", () => {
    const ms = Date.UTC(2026, 9, 14);
    const id = uuidv7(ms, (b) => b.fill(0xff));
    expect(isUuidv7(id)).toBe(true);
    expect(uuidv7Time(id)).toBe(ms);
    expect(id.slice(14, 15)).toBe("7");
  });

  it("sorts by creation time", () => {
    const a = uuidv7(1_000);
    const b = uuidv7(2_000);
    expect(a < b).toBe(true);
  });

  it("uses the platform random source by default and rejects bad input", () => {
    expect(isUuidv7(uuidv7())).toBe(true);
    expect(() => uuidv7(-1)).toThrow(RangeError);
    expect(() => uuidv7Time("not-an-id")).toThrow(TypeError);
  });
});

describe("MemoryStore", () => {
  it("commits a transaction atomically and rolls back on error", async () => {
    const store = new MemoryStore();
    await store.transaction((tx) => tx.put("a", { id: "1", v: 1 }));
    await expect(
      store.transaction((tx) => {
        tx.put("a", { id: "2", v: 2 });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(
      store.transaction(() => {
        throw "plain";
      }),
    ).rejects.toThrow("plain");
    expect(await store.list("a")).toEqual([{ id: "1", v: 1 }]);
    expect(await store.list("a", (r) => r["v"] === 2)).toEqual([]);
  });

  it("notifies listeners per touched table and wipes everything", async () => {
    const store = new MemoryStore();
    const seen: string[] = [];
    const stop = store.subscribe((t) => seen.push(t));
    await store.transaction((tx) => {
      tx.put("a", { id: "1" });
      tx.put("b", { id: "1" });
      tx.remove("b", "1");
      tx.remove("c", "missing");
    });
    expect(seen).toEqual(["a", "b"]);
    expect(await store.tables()).toEqual(["a"]);
    await store.wipe();
    expect(await store.tables()).toEqual([]);
    stop();
    await store.transaction((tx) => tx.put("a", { id: "2" }));
    expect(seen).toEqual(["a", "b", "a", "b"]);
  });
});

describe("mutations", () => {
  it("names record keys and default policies", () => {
    expect(recordKey("shifts", "s1")).toBe("shifts:s1");
    expect(defaultPolicy("insert")).toBe("append");
    expect(defaultPolicy("rpc")).toBe("cas");
    expect(defaultPolicy("update")).toBe("merge");
  });

  it("finds nothing to do in an empty queue", () => {
    expect(nextReady([], 0)).toEqual({ kind: "empty" });
  });

  it("does not let a write overtake an earlier write to the same record still in backoff", () => {
    const m = (id: string, seq: number, next: number): Mutation => ({
      id,
      seq,
      op: "update",
      target: "t",
      table: "t",
      rowId: "r",
      payload: {},
      base: null,
      policy: "merge",
      dependsOn: [],
      queuedAt: "",
      attempts: 0,
      nextAttemptAt: next,
      status: "pending",
      lastError: null,
      serverRow: null,
    });
    expect(nextReady([m("a", 1, 100), m("b", 2, 0)], 50)).toEqual({ kind: "backoff" });
  });
});

describe("conflict rules", () => {
  it("merges disjoint field edits and refuses overlapping ones", () => {
    const base = { id: "1", a: 1, b: 1 };
    expect(mergeFields(base, { id: "1", a: 2, b: 1 }, { b: 3 })).toEqual({ b: 3 });
    expect(mergeFields(base, { id: "1", a: 2, b: 1 }, { a: 2 })).toEqual({});
    expect(mergeFields(base, { id: "1", a: 2, b: 1 }, { a: 5 })).toBeNull();
  });

  it("compares structured values by content", () => {
    expect(sameValue({ x: [1] }, { x: [1] })).toBe(true);
    expect(sameValue({ x: 1 }, null)).toBe(false);
    expect(sameValue(1, "1")).toBe(false);
  });

  it("classifies server errors", () => {
    expect(
      classifyServerError({
        code: "23505",
        message: 'duplicate key value violates unique constraint "clock_punches_pkey"',
      }),
    ).toEqual({ kind: "duplicate" });
    expect(
      classifyServerError({
        code: "23505",
        message: 'violates unique constraint "kiosk_pins_membership_key"',
      }).kind,
    ).toBe("refused");
    expect(classifyServerError({ code: "XR001", message: "punch_already_in" })).toEqual({
      kind: "refused",
      error: { code: "XR001", message: "punch_already_in" },
    });
    expect(classifyServerError({ code: "42501", message: "denied" }).kind).toBe("refused");
    expect(classifyServerError({ status: 401, message: "JWT expired" }).kind).toBe("unauthorized");
    expect(classifyServerError({ code: "PGRST301" }).kind).toBe("unauthorized");
    expect(classifyServerError({ status: 503 })).toEqual({
      kind: "transient",
      error: { code: "503", message: "The server did not accept the change." },
    });
    expect(classifyServerError({ status: 429 }, 10_000)).toMatchObject({
      kind: "transient",
      retryAfterMs: 10_000,
    });
    expect(classifyServerError({ code: "40001", status: 409 }).kind).toBe("transient");
    expect(classifyServerError({ status: 400, code: "PGRST204" }).kind).toBe("refused");
    expect(classifyServerError({ status: 404 }).kind).toBe("refused");
  });
});

describe("offline event time", () => {
  function deviceClock(
    wall: number,
    mono: number,
    boot = "boot-1",
  ): DeviceClock & { set(w: number, m: number, b?: string): void } {
    let w = wall;
    let m = mono;
    let b = boot;
    return {
      wallNow: () => w,
      monotonicNow: () => m,
      bootId: () => b,
      set(nw, nm, nb = b) {
        w = nw;
        m = nm;
        b = nb;
      },
    };
  }

  it("estimates server time from the monotonic clock even when the wall clock was changed", () => {
    const server = Date.UTC(2026, 9, 14, 8, 0, 0);
    const clock = deviceClock(server + 1_000, 50_000);
    const anchor = anchorFromServer(clock, server, 400);
    expect(anchor).toEqual({ serverMs: server + 200, monotonicMs: 50_000, bootId: "boot-1" });
    clock.set(server + 3_600_000 + 3 * 3_600_000, 50_000 + 3_600_000);
    const event = stampEvent(clock, anchor);
    expect(event.monotonicOffsetMs).toBe(3_600_000);
    expect(event.estimatedServerAt).toBe(new Date(server + 200 + 3_600_000).toISOString());
    expect(event.skewMs).toBe(3 * 3_600_000 - 200);
    expect(needsReview(event)).toBe(true);
  });

  it("accepts a small skew and distrusts an anchor from before a reboot", () => {
    const clock = deviceClock(10_000, 0);
    const anchor = anchorFromServer(clock, 10_000);
    clock.set(70_500, 60_000);
    expect(needsReview(stampEvent(clock, anchor))).toBe(false);
    clock.set(80_000, 1_000, "boot-2");
    const afterReboot = stampEvent(clock, anchor);
    expect(afterReboot).toMatchObject({
      monotonicOffsetMs: null,
      skewMs: null,
      anchorServerAt: null,
    });
    expect(needsReview(afterReboot)).toBe(true);
    expect(stampEvent(clock, null).estimatedServerAt).toBeNull();
  });
});
