import { describe, expect, it } from "vitest";
import { MemoryStore, OFFLINE, ONLINE, Outbox, SyncEngine, type NetworkState } from "../src";
import { Clock, FakeServer, sequentialIds } from "./support";

function setup(network: NetworkState = OFFLINE) {
  const clock = new Clock();
  const store = new MemoryStore();
  const server = new FakeServer();
  const outbox = new Outbox(store, { now: clock.now, newId: sequentialIds() });
  const engine = new SyncEngine({
    store,
    outbox,
    uploader: server,
    network,
    now: clock.now,
    random: () => 0.5,
    backoff: { baseMs: 1_000, maxMs: 60_000 },
  });
  return { clock, store, server, outbox, engine };
}

function punch(id: string, kind: string) {
  return {
    op: "insert" as const,
    table: "clock_punches",
    rowId: id,
    payload: { punch_kind: kind },
    optimistic: { id, punch_kind: kind },
  };
}

describe("airplane mode", () => {
  it("applies writes locally and uploads nothing while offline", async () => {
    const { store, server, outbox, engine } = setup(OFFLINE);
    await outbox.enqueue(punch("p1", "In"));
    expect(await store.get("clock_punches", "p1")).toEqual({ id: "p1", punch_kind: "In" });
    expect(await engine.drain()).toEqual({ uploaded: 0, conflicts: 0, stoppedBy: "offline" });
    expect(server.received).toHaveLength(0);
    expect(await outbox.count()).toBe(1);
  });

  it("treats airplane mode as offline even when Wi-Fi reports connected", async () => {
    const { server, outbox, engine } = setup({ ...ONLINE, isAirplaneMode: true });
    await outbox.enqueue(punch("p1", "In"));
    expect((await engine.drain()).stoppedBy).toBe("offline");
    expect(server.received).toHaveLength(0);
  });

  it("drains in order when the network comes back", async () => {
    const { server, outbox, engine } = setup(OFFLINE);
    await outbox.enqueue(punch("p1", "In"));
    await outbox.enqueue(punch("p2", "Break Start"));
    await outbox.enqueue(punch("p3", "Break End"));
    const report = await engine.setNetwork(ONLINE);
    expect(report).toEqual({ uploaded: 3, conflicts: 0, stoppedBy: "empty" });
    expect(server.received.map((m) => m.rowId)).toEqual(["p1", "p2", "p3"]);
    expect(await outbox.count()).toBe(0);
  });

  it("does not drain again when an online network reports another online state", () => {
    const { engine } = setup(ONLINE);
    expect(engine.setNetwork({ ...ONLINE, isExpensive: true })).toBeNull();
  });

  it("stops before the next upload when airplane mode turns on mid-drain", async () => {
    const { server, outbox, engine } = setup(ONLINE);
    await outbox.enqueue(punch("p1", "In"));
    await outbox.enqueue(punch("p2", "Out"));
    const original = server.upload.bind(server);
    server.upload = async (m) => {
      const outcome = await original(m);
      engine.setNetwork({ ...ONLINE, isAirplaneMode: true });
      return outcome;
    };
    expect(await engine.drain()).toEqual({ uploaded: 1, conflicts: 0, stoppedBy: "offline" });
    expect(server.received.map((m) => m.rowId)).toEqual(["p1"]);
    expect(await outbox.count()).toBe(1);
  });

  it("never doubles a write whose response was lost when the network dropped", async () => {
    const { clock, server, outbox, engine } = setup(ONLINE);
    await outbox.enqueue(punch("p1", "In"));
    server.script.push("drop-response");
    expect((await engine.drain()).stoppedBy).toBe("transient");
    expect(server.row("clock_punches", "p1")).toBeDefined();
    expect(await outbox.count()).toBe(1);
    clock.advance(10_000);
    expect(await engine.drain()).toEqual({ uploaded: 1, conflicts: 0, stoppedBy: "empty" });
    expect(server.tables.get("clock_punches")?.size).toBe(1);
    expect(await outbox.count()).toBe(0);
  });
});

describe("retry and backoff", () => {
  it("holds the whole queue behind a write waiting to retry, preserving order", async () => {
    const { clock, server, outbox, engine } = setup(ONLINE);
    await outbox.enqueue(punch("p1", "In"));
    await outbox.enqueue(punch("p2", "Out"));
    server.script.push("network-down");
    expect((await engine.drain()).stoppedBy).toBe("transient");
    const waiting = await outbox.get("01920000-0000-7000-8000-000000000001");
    expect(waiting?.attempts).toBe(1);
    expect(waiting?.lastError?.message).toBe("Network request failed");
    expect((await engine.drain()).stoppedBy).toBe("backoff");
    expect(server.received.map((m) => m.rowId)).toEqual(["p1"]);
    clock.advance(1_000);
    expect(await engine.drain()).toEqual({ uploaded: 2, conflicts: 0, stoppedBy: "empty" });
    expect(server.received.map((m) => m.rowId)).toEqual(["p1", "p1", "p2"]);
  });

  it("grows the backoff exponentially with jitter, capped, and honors Retry-After", () => {
    const { engine } = setup();
    expect(engine.backoffMs(0)).toBe(750);
    expect(engine.backoffMs(3)).toBe(6_000);
    expect(engine.backoffMs(20)).toBe(45_000);
    expect(engine.backoffMs(0, 30_000)).toBe(30_000);
  });

  it("schedules a rate-limited write after the server's Retry-After", async () => {
    const { clock, server, outbox, engine } = setup(ONLINE);
    await outbox.enqueue(punch("p1", "In"));
    server.script.push("rate-limit");
    await engine.drain();
    expect((await outbox.all())[0]?.nextAttemptAt).toBe(clock.ms + 30_000);
  });

  it("shares one drain between concurrent callers", async () => {
    const { server, outbox, engine } = setup(ONLINE);
    await outbox.enqueue(punch("p1", "In"));
    const [a, b] = await Promise.all([engine.drain(), engine.drain()]);
    expect(a).toBe(b);
    expect(server.received).toHaveLength(1);
  });
});

describe("sign-in expiry", () => {
  it("halts uploads until sign-in is restored", async () => {
    const { server, outbox, engine } = setup(ONLINE);
    await outbox.enqueue(punch("p1", "In"));
    server.script.push("unauthorized");
    expect((await engine.drain()).stoppedBy).toBe("auth");
    expect((await engine.status()).authRequired).toBe(true);
    expect((await engine.drain()).stoppedBy).toBe("auth");
    expect(await engine.authRestored()).toEqual({ uploaded: 1, conflicts: 0, stoppedBy: "empty" });
  });
});

describe("conflicts", () => {
  it("parks a refused write without freezing unrelated writes", async () => {
    const { server, outbox, engine } = setup(ONLINE);
    await outbox.enqueue(punch("p1", "In"));
    await outbox.enqueue({
      op: "update",
      table: "shifts",
      rowId: "s1",
      payload: { note: "Gate B" },
    });
    await outbox.enqueue(punch("p2", "In"));
    server.refuseWhen = (m) => m.rowId === "p1";
    expect(await engine.drain()).toEqual({ uploaded: 2, conflicts: 1, stoppedBy: "blocked" });
    const [conflict] = await outbox.conflicts();
    expect(conflict?.rowId).toBe("p1");
    expect(conflict?.lastError).toEqual({ code: "XR001", message: "punch_already_in" });
    expect((await engine.status()).conflicts).toBe(1);
  });

  it("holds later writes to the same record and dependents behind a conflict", async () => {
    const { server, outbox, engine } = setup(ONLINE);
    const incident = await outbox.enqueue({
      op: "insert",
      table: "incidents",
      rowId: "i1",
      payload: { title: "Fall" },
      optimistic: { id: "i1", title: "Fall" },
    });
    await outbox.enqueue({
      op: "insert",
      table: "incident_media",
      rowId: "m1",
      payload: { incident_id: "i1" },
      dependsOn: [incident.id],
      optimistic: { id: "m1", incident_id: "i1" },
    });
    await outbox.enqueue({
      op: "update",
      table: "incidents",
      rowId: "i1",
      payload: { title: "Fall at Gate B" },
    });
    server.refuseWhen = (m) => m.rowId === "i1" && m.op === "insert";
    expect(await engine.drain()).toEqual({ uploaded: 0, conflicts: 1, stoppedBy: "blocked" });
    expect(server.received).toHaveLength(1);
  });

  it("discarding a conflict reverts the optimistic rows of it and its dependents", async () => {
    const { store, server, outbox, engine } = setup(ONLINE);
    const incident = await outbox.enqueue({
      op: "insert",
      table: "incidents",
      rowId: "i1",
      payload: { title: "Fall" },
      optimistic: { id: "i1", title: "Fall" },
    });
    await outbox.enqueue({
      op: "insert",
      table: "incident_media",
      rowId: "m1",
      payload: { incident_id: "i1" },
      dependsOn: [incident.id],
      optimistic: { id: "m1", incident_id: "i1" },
    });
    server.refuseWhen = (m) => m.rowId === "i1";
    await engine.drain();
    await outbox.resolve(incident.id, { action: "discard" });
    expect(await outbox.count()).toBe(0);
    expect(await store.get("incidents", "i1")).toBeUndefined();
    expect(await store.get("incident_media", "m1")).toBeUndefined();
  });

  it("retrying a conflict with an edited payload sends again from the server's row", async () => {
    const { server, outbox, engine } = setup(ONLINE);
    const m = await outbox.enqueue(punch("p1", "In"));
    server.script.push("refuse");
    await engine.drain();
    await outbox.resolve(m.id, { action: "retry", payload: { punch_kind: "Out" } });
    expect(await engine.drain()).toEqual({ uploaded: 1, conflicts: 0, stoppedBy: "empty" });
    expect(server.row("clock_punches", "p1")).toEqual({ id: "p1", punch_kind: "Out" });
  });

  it("merges an update automatically when the server changed other fields", async () => {
    const { store, server, outbox, engine } = setup(ONLINE);
    const base = { id: "t1", title: "Check rigging", note: "", version: 1 };
    server.seed("tasks", { ...base, title: "Check rigging points", version: 2 });
    await store.transaction((tx) => tx.put("tasks", base));
    await outbox.enqueue({
      op: "update",
      table: "tasks",
      rowId: "t1",
      payload: { note: "Done at 14:00" },
      optimistic: { ...base, note: "Done at 14:00" },
    });
    expect(await engine.drain()).toEqual({ uploaded: 1, conflicts: 0, stoppedBy: "empty" });
    expect(server.row("tasks", "t1")).toEqual({
      id: "t1",
      title: "Check rigging points",
      note: "Done at 14:00",
      version: 3,
    });
    expect(await store.get("tasks", "t1")).toEqual(server.row("tasks", "t1"));
  });

  it("surfaces a field both sides changed in the resolution sheet with the server's version", async () => {
    const { store, server, outbox, engine } = setup(ONLINE);
    const base = { id: "t1", note: "", version: 1 };
    server.seed("tasks", { id: "t1", note: "Moved to dock 2", version: 2 });
    await store.transaction((tx) => tx.put("tasks", base));
    await outbox.enqueue({
      op: "update",
      table: "tasks",
      rowId: "t1",
      payload: { note: "Done" },
      optimistic: { ...base, note: "Done" },
    });
    expect((await engine.drain()).conflicts).toBe(1);
    const [conflict] = await outbox.conflicts();
    expect(conflict?.serverRow).toEqual({ id: "t1", note: "Moved to dock 2", version: 2 });
    expect(conflict?.lastError?.code).toBe("stale");
  });

  it("goes to the resolution sheet when the server keeps changing the row", async () => {
    const { server, outbox, engine, store } = setup(ONLINE);
    const base = { id: "t1", title: "A", note: "", version: 1 };
    await store.transaction((tx) => tx.put("tasks", base));
    server.seed("tasks", { ...base, title: "B", version: 2 });
    server.script.push("stale", "stale", "stale", "stale");
    await outbox.enqueue({
      op: "update",
      table: "tasks",
      rowId: "t1",
      payload: { note: "x" },
      optimistic: { ...base, note: "x" },
    });
    expect(await engine.drain()).toEqual({ uploaded: 0, conflicts: 1, stoppedBy: "blocked" });
    expect((await outbox.conflicts())[0]?.lastError?.message).toBe(
      "This record keeps changing on the server.",
    );
  });

  it("a compare-and-set transition that lost the race becomes a conflict", async () => {
    const { server, outbox, engine } = setup(ONLINE);
    server.seed("incidents", { id: "i1", state: "Dispatched" });
    await outbox.enqueue({
      op: "rpc",
      target: "transition_incident",
      table: "incidents",
      rowId: "i1",
      payload: { expected: "Reported", next: "Contained" },
    });
    expect((await engine.drain()).conflicts).toBe(1);
    expect((await outbox.conflicts())[0]?.lastError).toEqual({
      code: "XR001",
      message: "transition_stale",
    });
  });

  it("a replayed RPC is answered from the server ledger", async () => {
    const { clock, server, outbox, engine } = setup(ONLINE);
    server.seed("incidents", { id: "i1", state: "Reported" });
    await outbox.enqueue({
      op: "rpc",
      target: "transition_incident",
      table: "incidents",
      rowId: "i1",
      payload: { expected: "Reported", next: "Contained" },
    });
    server.script.push("drop-response");
    await engine.drain();
    clock.advance(5_000);
    expect(await engine.drain()).toEqual({ uploaded: 1, conflicts: 0, stoppedBy: "empty" });
    expect(server.row("incidents", "i1")).toEqual({ id: "i1", state: "Contained" });
  });
});

describe("status", () => {
  it("reports the visible queue count to subscribers", async () => {
    const { outbox, engine } = setup(OFFLINE);
    const seen: number[] = [];
    const stop = engine.subscribe((s) => seen.push(s.queued));
    await outbox.enqueue(punch("p1", "In"));
    await new Promise((r) => setTimeout(r, 0));
    stop();
    expect(seen.at(-1)).toBe(1);
    const status = await engine.status();
    expect(status).toMatchObject({
      online: false,
      draining: false,
      queued: 1,
      conflicts: 0,
      authRequired: false,
    });
    expect(engine.network).toBe(OFFLINE);
  });
});
