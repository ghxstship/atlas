import { describe, expect, it } from "vitest";
import {
  createLiveHub,
  isLiveTopic,
  realtimeEndpoint,
  reconnectDelay,
  type LiveChannelLike,
  type LiveChange,
  type LiveClientLike,
  type LiveClientOptions,
  type LiveClock,
  type LivePayload,
  type LiveVisibility,
} from "../src/live.ts";

/** A clock whose timers run when the test advances it. */
function fakeClock() {
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const clock: LiveClock = {
    now: () => now,
    setTimeout: (run, ms) => {
      seq += 1;
      timers.set(seq, { at: now + ms, run });
      return seq;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].run();
    }
    now = end;
  };
  return { clock, advance };
}

interface FakeChannel extends LiveChannelLike {
  readonly topic: string;
  readonly bindings: { table: string; filter?: string; callback: (p: LivePayload) => void }[];
  status: ((status: string) => void) | null;
  removed: boolean;
}

function fakeRealtime() {
  const channels: FakeChannel[] = [];
  const clients: { endpoint: string; options: LiveClientOptions; disconnected: boolean }[] = [];
  const create = (endpoint: string, options: LiveClientOptions): LiveClientLike => {
    const record = { endpoint, options, disconnected: false };
    clients.push(record);
    return {
      channel(topic) {
        const channel: FakeChannel = {
          topic,
          bindings: [],
          status: null,
          removed: false,
          on(_type, filter, callback) {
            channel.bindings.push({
              table: filter.table,
              ...(filter.filter ? { filter: filter.filter } : {}),
              callback,
            });
            return channel;
          },
          subscribe(callback) {
            channel.status = callback;
            return channel;
          },
        };
        channels.push(channel);
        return channel;
      },
      removeChannel(channel) {
        (channel as FakeChannel).removed = true;
        return Promise.resolve("ok");
      },
      disconnect() {
        record.disconnected = true;
      },
    };
  };
  const live = () => channels.filter((c) => !c.removed);
  const emit = (table: string, eventType: string, row: Record<string, unknown>) => {
    for (const channel of live()) {
      for (const b of channel.bindings) {
        if (b.table === table) b.callback({ eventType, table, new: row, old: {} });
      }
    }
  };
  return { create, channels, clients, live, emit };
}

function visibilityStub(): LiveVisibility & { set(hidden: boolean): void } {
  let hidden = false;
  const listeners = new Set<() => void>();
  return {
    hidden: () => hidden,
    onChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    set(next) {
      hidden = next;
      for (const cb of listeners) cb();
    },
  };
}

function setup(
  overrides: { token?: () => Promise<{ token: string; expiresAt: number } | null> } = {},
) {
  const time = fakeClock();
  const realtime = fakeRealtime();
  const visibility = visibilityStub();
  const tokens: number[] = [];
  const hub = createLiveHub({
    url: "https://example.supabase.co/",
    apiKey: "publishable-key-for-tests",
    token:
      overrides.token ??
      (() => {
        tokens.push(time.clock.now());
        return Promise.resolve({
          token: `t${tokens.length}`,
          expiresAt: time.clock.now() + 3_600_000,
        });
      }),
    createClient: realtime.create,
    clock: time.clock,
    visibility,
    random: () => 0.5,
  });
  return { hub, time, realtime, visibility, tokens };
}

describe("live topics and endpoints", () => {
  it("accepts plain tables with one simple filter and refuses anything else", () => {
    expect(isLiveTopic({ table: "records" })).toBe(true);
    expect(
      isLiveTopic({ table: "records", filter: "org_id=eq.6f1c7e0e-0000-4000-8000-000000000001" }),
    ).toBe(true);
    expect(isLiveTopic({ table: "records", filter: "id=in.(a,b,c)" })).toBe(true);
    expect(isLiveTopic({ table: "app.records" })).toBe(false);
    expect(isLiveTopic({ table: "Records" })).toBe(false);
    expect(isLiveTopic({ table: "records", filter: "org_id=like.%x%" })).toBe(false);
    expect(isLiveTopic({ table: "records", filter: "a=eq.1,b=eq.2" })).toBe(false);
  });

  it("derives the websocket endpoint from the API origin", () => {
    expect(realtimeEndpoint("https://xyz.supabase.co/")).toBe("wss://xyz.supabase.co/realtime/v1");
    expect(realtimeEndpoint("http://127.0.0.1:62221")).toBe("ws://127.0.0.1:62221/realtime/v1");
  });

  it("backs off reconnects from 1 s to 30 s with jitter", () => {
    expect(reconnectDelay(1, () => 0.5)).toBe(1_000);
    expect(reconnectDelay(2, () => 0.5)).toBe(2_000);
    expect(reconnectDelay(4, () => 0.5)).toBe(8_000);
    expect(reconnectDelay(20, () => 0.5)).toBe(30_000);
    expect(reconnectDelay(20, () => 0)).toBe(15_000);
    expect(reconnectDelay(20, () => 0.999)).toBeLessThan(45_000);
  });
});

describe("createLiveHub", () => {
  it("multiplexes every watcher on one channel and rebuilds once per burst of watches", () => {
    const { hub, time, realtime } = setup();
    const a: LiveChange[][] = [];
    const b: LiveChange[][] = [];
    hub.watch([{ table: "records", filter: "org_id=eq.o1" }], (c) => a.push([...c]));
    hub.watch(
      [
        { table: "records", filter: "org_id=eq.o1" },
        { table: "shifts", filter: "org_id=eq.o1" },
      ],
      (c) => b.push([...c]),
    );
    time.advance(60);
    expect(realtime.clients).toHaveLength(1);
    expect(realtime.clients[0]?.endpoint).toBe("wss://example.supabase.co/realtime/v1");
    expect(realtime.live()).toHaveLength(1);
    expect(realtime.live()[0]?.bindings.map((x) => `${x.table}|${x.filter}`)).toEqual([
      "records|org_id=eq.o1",
      "shifts|org_id=eq.o1",
    ]);
    expect(hub.status()).toBe("connecting");
    realtime.live()[0]?.status?.("SUBSCRIBED");
    expect(hub.status()).toBe("live");

    realtime.emit("records", "UPDATE", { id: "r1" });
    realtime.emit("shifts", "INSERT", { id: "s1" });
    time.advance(300);
    expect(a).toEqual([[{ table: "records", type: "UPDATE", id: "r1" }]]);
    expect(b).toEqual([
      [
        { table: "records", type: "UPDATE", id: "r1" },
        { table: "shifts", type: "INSERT", id: "s1" },
      ],
    ]);
  });

  it("gathers a burst into one batch and never delivers more often than the interval", () => {
    const { hub, time, realtime } = setup();
    const batches: LiveChange[][] = [];
    hub.watch([{ table: "records" }], (c) => batches.push([...c]));
    time.advance(60);
    for (let i = 0; i < 5; i += 1) realtime.emit("records", "UPDATE", { id: "r1" });
    realtime.emit("records", "UPDATE", { id: "r2" });
    time.advance(300);
    expect(batches).toEqual([
      [
        { table: "records", type: "UPDATE", id: "r1" },
        { table: "records", type: "UPDATE", id: "r2" },
      ],
    ]);
    realtime.emit("records", "UPDATE", { id: "r3" });
    time.advance(300);
    expect(batches).toHaveLength(1); // held until 2 s after the first batch
    time.advance(1_700);
    expect(batches).toHaveLength(2);
  });

  it("doubles the interval while changes keep coming, so a loop cannot refetch fast", () => {
    const { hub, time, realtime } = setup();
    const at: number[] = [];
    hub.watch([{ table: "records" }], () => at.push(time.clock.now()));
    time.advance(60);
    // A change every 500 ms for two minutes: the shape of a page that writes a row it watches.
    for (let i = 0; i < 240; i += 1) {
      realtime.emit("records", "UPDATE", { id: `r${i % 3}` });
      time.advance(500);
    }
    const gaps = at.slice(1).map((t, i) => t - (at[i] ?? 0));
    expect(at.length).toBeLessThan(12);
    expect(gaps.at(-1)).toBe(30_000);
    // A quiet spell resets the pace.
    time.advance(120_000);
    const before = at.length;
    realtime.emit("records", "UPDATE", { id: "r9" });
    time.advance(300);
    expect(at.length).toBe(before + 1);
    realtime.emit("records", "UPDATE", { id: "r10" });
    time.advance(2_000);
    expect(at.length).toBe(before + 2);
  });

  it("paces show mode on its own, faster interval", () => {
    const { hub, time, realtime } = setup();
    const at: number[] = [];
    hub.watch([{ table: "cues", filter: "project_id=eq.p1" }], () => at.push(time.clock.now()), {
      batchMs: 50,
      minIntervalMs: 250,
      maxIntervalMs: 1_000,
    });
    time.advance(60);
    const start = time.clock.now();
    realtime.emit("cues", "UPDATE", { id: "c1" });
    time.advance(50);
    expect(at).toEqual([start + 50]);
    for (let i = 0; i < 20; i += 1) {
      realtime.emit("cues", "UPDATE", { id: "c2" });
      time.advance(200);
    }
    const gaps = at.slice(1).map((t, i) => t - (at[i] ?? 0));
    expect(Math.max(...gaps)).toBeLessThanOrEqual(1_000);
  });

  it("holds batches while the tab is hidden and delivers once when it is visible", () => {
    const { hub, time, realtime, visibility } = setup();
    const batches: LiveChange[][] = [];
    hub.watch([{ table: "records" }], (c) => batches.push([...c]));
    time.advance(60);
    visibility.set(true);
    realtime.emit("records", "UPDATE", { id: "r1" });
    time.advance(10_000);
    realtime.emit("records", "DELETE", { id: "r2" });
    time.advance(10_000);
    expect(batches).toHaveLength(0);
    visibility.set(false);
    expect(batches).toEqual([
      [
        { table: "records", type: "UPDATE", id: "r1" },
        { table: "records", type: "DELETE", id: "r2" },
      ],
    ]);
  });

  it("collapses a flood into one RESYNC", () => {
    const { hub, time, realtime } = setup();
    const batches: LiveChange[][] = [];
    hub.watch([{ table: "records" }], (c) => batches.push([...c]));
    time.advance(60);
    for (let i = 0; i < 150; i += 1) realtime.emit("records", "INSERT", { id: `r${i}` });
    time.advance(300);
    expect(batches).toEqual([[{ table: "*", type: "RESYNC", id: null }]]);
  });

  it("resyncs once after a dropped connection comes back", () => {
    const { hub, time, realtime } = setup();
    const batches: LiveChange[][] = [];
    hub.watch([{ table: "records" }], (c) => batches.push([...c]));
    time.advance(60);
    const channel = realtime.live()[0];
    channel?.status?.("SUBSCRIBED");
    channel?.status?.("CHANNEL_ERROR");
    expect(hub.status()).toBe("reconnecting");
    channel?.status?.("SUBSCRIBED");
    expect(hub.status()).toBe("live");
    time.advance(300);
    expect(batches).toEqual([[{ table: "*", type: "RESYNC", id: null }]]);
  });

  it("keeps the socket across pages and closes it after an idle minute", () => {
    const { hub, time, realtime } = setup();
    const stop = hub.watch([{ table: "records" }], () => undefined);
    time.advance(60);
    stop();
    time.advance(60);
    expect(realtime.live()).toHaveLength(0);
    expect(hub.status()).toBe("idle");
    hub.watch([{ table: "shifts" }], () => undefined);
    time.advance(60);
    expect(realtime.clients).toHaveLength(1);
    expect(realtime.live()[0]?.bindings.map((b) => b.table)).toEqual(["shifts"]);
    const stop2 = hub.watch([{ table: "shifts" }], () => undefined);
    time.advance(60);
    expect(realtime.channels.filter((c) => c.bindings[0]?.table === "shifts")).toHaveLength(1);
    stop2();
    time.advance(60);
    expect(realtime.live()).toHaveLength(1);
    hub.close();
    expect(realtime.clients[0]?.disconnected).toBe(true);
  });

  it("disconnects after the idle time once nothing is watched", () => {
    const { hub, time, realtime } = setup();
    const stop = hub.watch([{ table: "records" }], () => undefined);
    time.advance(60);
    stop();
    time.advance(61_000);
    expect(realtime.clients[0]?.disconnected).toBe(true);
  });

  it("ignores invalid topics and unknown events", () => {
    const { hub, time, realtime } = setup();
    const batches: LiveChange[][] = [];
    const stop = hub.watch([{ table: "app.records" }], (c) => batches.push([...c]));
    time.advance(60);
    expect(realtime.clients).toHaveLength(0);
    stop();
    hub.watch([{ table: "records" }], (c) => batches.push([...c]));
    time.advance(60);
    for (const b of realtime.live()[0]?.bindings ?? []) {
      b.callback({ eventType: "TRUNCATE", table: "records", new: {}, old: {} });
      b.callback({ eventType: "DELETE", table: "records", new: {}, old: { id: "r1" } });
    }
    time.advance(300);
    expect(batches).toEqual([[{ table: "records", type: "DELETE", id: "r1" }]]);
  });

  it("caches the token until a minute before it expires, and goes offline when signed out", async () => {
    const { hub, time, realtime, tokens } = setup();
    hub.watch([{ table: "records" }], () => undefined);
    time.advance(60);
    const access = realtime.clients[0]?.options.accessToken;
    expect(await access?.()).toBe("t1");
    time.advance(30 * 60_000);
    expect(await access?.()).toBe("t1");
    time.advance(29 * 60_000 + 30_000);
    expect(await access?.()).toBe("t2");
    expect(tokens).toHaveLength(2);

    const signedOut = setup({ token: () => Promise.resolve(null) });
    signedOut.hub.watch([{ table: "records" }], () => undefined);
    signedOut.time.advance(60);
    expect(await signedOut.realtime.clients[0]?.options.accessToken()).toBeNull();
    expect(signedOut.hub.status()).toBe("offline");
  });

  it("keeps the last token through a failed refresh until it expires", async () => {
    let calls = 0;
    const time = fakeClock();
    const realtime = fakeRealtime();
    const hub = createLiveHub({
      url: "http://127.0.0.1:62221",
      apiKey: "publishable-key-for-tests",
      token: () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve({ token: "first", expiresAt: time.clock.now() + 90_000 })
          : Promise.reject(new Error("offline"));
      },
      createClient: realtime.create,
      clock: time.clock,
      visibility: visibilityStub(),
    });
    hub.watch([{ table: "records" }], () => undefined);
    time.advance(60);
    const access = realtime.clients[0]?.options.accessToken;
    expect(await access?.()).toBe("first");
    time.advance(40_000);
    expect(await access?.()).toBe("first");
    time.advance(60_000);
    expect(await access?.()).toBeNull();
  });

  it("reports status changes and stops after close", () => {
    const { hub, time, realtime } = setup();
    const seen: string[] = [];
    const off = hub.onStatus((s) => seen.push(s));
    hub.watch([{ table: "records" }], () => undefined);
    time.advance(60);
    realtime.live()[0]?.status?.("SUBSCRIBED");
    off();
    realtime.live()[0]?.status?.("TIMED_OUT");
    expect(seen).toEqual(["connecting", "live"]);
    hub.close();
    expect(hub.watch([{ table: "records" }], () => undefined)()).toBeUndefined();
  });
});
