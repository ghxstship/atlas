import type { MutationInput } from "@xos/sync";
import { describe, expect, it } from "vitest";
import {
  afterServer,
  buildKioskPunch,
  hasQueuedPunch,
  KIOSK_KNOWLEDGE_MS,
  KIOSK_SEND_ATTEMPTS,
  KioskSendTimeout,
  kioskWarmer,
  learnShift,
  pickWorker,
  refusalFromServer,
  rosterWithKnowledge,
  sendKioskPunch,
  singleFlight,
  submitKioskPunch,
  withSendTimeout,
  type KioskResponse,
  type KioskStep,
  type RosterEntry,
} from "../src/domain/kiosk";

/** A server that answers the given statuses in turn and counts the requests. */
function server(...statuses: number[]) {
  let calls = 0;
  const send = () => {
    const status = statuses[Math.min(calls, statuses.length - 1)] ?? 500;
    calls += 1;
    return Promise.resolve({ status });
  };
  return { send, calls: () => calls };
}

const pauses: number[] = [];
const pause = (ms: number) => {
  pauses.push(ms);
  return Promise.resolve();
};

describe("A66: a kiosk punch is sent again when the server could not answer", () => {
  it("sends again after a 546 from a worker that hit its CPU limit, and returns the verdict", async () => {
    const s = server(546, 422);
    expect((await sendKioskPunch(s.send, KIOSK_SEND_ATTEMPTS, pause)).status).toBe(422);
    expect(s.calls()).toBe(2);
  });

  it("returns the first answer that is not a server error, without sending again", async () => {
    for (const status of [200, 401, 422]) {
      const s = server(status, 200);
      expect((await sendKioskPunch(s.send, KIOSK_SEND_ATTEMPTS, pause)).status).toBe(status);
      expect(s.calls()).toBe(1);
    }
  });

  it("stops after three tries and hands back the last server error, for the queue to keep", async () => {
    pauses.length = 0;
    const s = server(503, 546, 504, 200);
    expect((await sendKioskPunch(s.send, KIOSK_SEND_ATTEMPTS, pause)).status).toBe(504);
    expect(s.calls()).toBe(3);
    expect(pauses).toEqual([500, 1000]);
  });

  it("lets a network error through at once, so the kiosk queues the punch", async () => {
    let calls = 0;
    const send = () => {
      calls += 1;
      return Promise.reject(new TypeError("Network request failed"));
    };
    await expect(sendKioskPunch(send, KIOSK_SEND_ATTEMPTS, pause)).rejects.toThrow(
      "Network request failed",
    );
    expect(calls).toBe(1);
  });
});

const avery: RosterEntry = { membershipId: "m1", displayName: "Avery Cole", onShift: false };
const riley: RosterEntry = { membershipId: "m2", displayName: "Riley Stone", onShift: true };

function punchFor(worker: RosterEntry, id = "0193a000-0000-7000-8000-000000000001") {
  return buildKioskPunch(
    {
      deviceKey: `xkio_${"a".repeat(64)}`,
      projectId: "p1",
      worker,
      pin: "1234",
      deviceAt: "2026-11-27T15:00:00.000Z",
      monotonicAt: 5_000,
      bootId: "boot-1",
      photoUri: null,
    },
    1_000,
    () => id,
  );
}

const answer = (status: number, body: unknown = {}): KioskResponse => ({
  status,
  ok: status >= 200 && status < 300,
  json: () => Promise.resolve(body),
});

/**
 * A stand-in for app.kiosk_punch and app.record_punch as the kiosk sees them: a punch id is recorded
 * once, a second clock-in while clocked in is punch_already_in, a clock-out while out is punch_not_in.
 */
function punchServer() {
  const recorded = new Map<string, string>();
  const onShift = new Set<string>();
  const handle = (body: Record<string, unknown>): KioskResponse => {
    const id = String(body["punchId"]);
    const member = String(body["membershipId"]);
    const kind = String(body["punchKind"]);
    if (recorded.has(id)) return answer(200, { punch_id: id });
    if (kind === "In" && onShift.has(member))
      return answer(422, { refusal: "REFUSE", reason: "punch_already_in" });
    if (kind === "Out" && !onShift.has(member))
      return answer(422, { refusal: "REFUSE", reason: "punch_not_in" });
    recorded.set(id, kind);
    if (kind === "In") onShift.add(member);
    else onShift.delete(member);
    return answer(200, { punch_id: id });
  };
  return { handle, recorded, onShift };
}

describe("4.19: one tap at a kiosk is one punch, whatever the server does", () => {
  it("records the punch once when the server answers 546 and then 200", async () => {
    const server = punchServer();
    const statuses = [546, 546];
    const queue: unknown[] = [];
    const outcome = await submitKioskPunch(punchFor(avery), {
      online: true,
      enqueue: (m) => Promise.resolve(queue.push(m)),
      post: (body) =>
        Promise.resolve(statuses.length > 0 ? answer(must(statuses.shift())) : server.handle(body)),
      pause,
    });
    expect(outcome).toEqual({ ok: true });
    expect([...server.recorded.values()]).toEqual(["In"]);
    expect(queue).toEqual([]);
  });

  it("records once when the server recorded the punch but its answer was lost, and the queue sends it again", async () => {
    const server = punchServer();
    const punch = punchFor(avery);
    const queue: (typeof punch)[] = [];
    // The punch reaches the database, then every answer is a 546: the kiosk never hears "recorded".
    const outcome = await submitKioskPunch(punch, {
      online: true,
      enqueue: (m) => Promise.resolve(queue.push(m)),
      post: (body) => {
        server.handle(body);
        return Promise.resolve(answer(546));
      },
      pause,
    });
    expect(outcome).toEqual({ ok: "queued" });
    expect(queue).toHaveLength(1);
    // The queue uploads the same punch id; the server answers with the punch it already has.
    const replay = server.handle(must(queue[0]).payload);
    expect(replay.status).toBe(200);
    expect(server.recorded.size).toBe(1);
    expect(must(queue[0]).rowId).toBe(punch.rowId);
    expect(must(queue[0]).payload["punchId"]).toBe(punch.rowId);
  });

  it("queues the punch, with its id, when a request hangs past the time limit", async () => {
    const queue: unknown[] = [];
    const signals: AbortSignal[] = [];
    const outcome = await submitKioskPunch(punchFor(avery), {
      online: true,
      timeoutMs: 20,
      enqueue: (m) => Promise.resolve(queue.push(m)),
      post: (_body, signal) => {
        signals.push(signal);
        return new Promise<KioskResponse>(() => undefined);
      },
      pause,
    });
    expect(outcome).toEqual({ ok: "queued" });
    expect(queue).toHaveLength(1);
    expect(signals).toHaveLength(1);
    expect(must(signals[0]).aborted).toBe(true);
  });

  it("queues without a request when offline, on a network error, and on an answer that is neither a verdict", async () => {
    for (const post of [
      () => Promise.reject(new TypeError("Network request failed")),
      () => Promise.resolve(answer(401)),
      () => Promise.resolve(answer(404)),
    ]) {
      const queue: unknown[] = [];
      const enqueue = (m: unknown) => Promise.resolve(queue.push(m));
      expect(
        await submitKioskPunch(punchFor(avery), { online: true, enqueue, post, pause }),
      ).toEqual({
        ok: "queued",
      });
      expect(queue).toHaveLength(1);
    }
    let requests = 0;
    const queue: unknown[] = [];
    const offline = await submitKioskPunch(punchFor(avery), {
      online: false,
      enqueue: (m) => Promise.resolve(queue.push(m)),
      post: () => {
        requests += 1;
        return Promise.resolve(answer(200));
      },
    });
    expect(offline).toEqual({ ok: "queued" });
    expect(requests).toBe(0);
    expect(queue).toHaveLength(1);
  });

  it("returns a refusal with its reason and queues nothing", async () => {
    const queue: unknown[] = [];
    const enqueue = (m: unknown) => Promise.resolve(queue.push(m));
    expect(
      await submitKioskPunch(punchFor(avery), {
        online: true,
        enqueue,
        post: () =>
          Promise.resolve(answer(422, { refusal: "REFUSE", reason: "kiosk_pin_rejected" })),
      }),
    ).toEqual({ ok: false, reason: "kiosk_pin_rejected" });
    // A 422 that cannot be read is still a refusal, never a queued punch that would be refused again.
    expect(
      await submitKioskPunch(punchFor(avery), {
        online: true,
        enqueue,
        post: () =>
          Promise.resolve({
            status: 422,
            ok: false,
            json: () => Promise.reject(new Error("not JSON")),
          }),
      }),
    ).toEqual({ ok: false, reason: "kiosk_request_invalid" });
    expect(queue).toEqual([]);
  });

  it("queues the punch with its photo when the photo cannot be stored yet", async () => {
    const queue: unknown[] = [];
    let requests = 0;
    const outcome = await submitKioskPunch(punchFor(avery), {
      online: true,
      enqueue: (m) => Promise.resolve(queue.push(m)),
      storePhoto: () => Promise.resolve(false),
      post: () => {
        requests += 1;
        return Promise.resolve(answer(200));
      },
    });
    expect(outcome).toEqual({ ok: "queued" });
    expect(requests).toBe(0);
    expect(queue).toHaveLength(1);
  });

  it("queues a clock-out behind the worker's queued clock-in, so the server takes them in order", async () => {
    const server = punchServer();
    // The clock-in got no answer and waits in the queue; the synced rows do not show it yet.
    const clockIn = punchFor(avery, "0193a000-0000-7000-8000-000000000011");
    const queue: MutationInput[] = [clockIn];
    const pending = () =>
      queue.map((m) => ({ table: m.table, status: "pending", payload: m.payload }));
    let requests = 0;
    const clockOut = punchFor({ ...avery, onShift: true }, "0193a000-0000-7000-8000-000000000012");
    const outcome = await submitKioskPunch(clockOut, {
      online: true,
      enqueue: (m) => Promise.resolve(queue.push(m)),
      queuedAhead: () => Promise.resolve(hasQueuedPunch(pending(), avery.membershipId)),
      post: (body) => {
        requests += 1;
        return Promise.resolve(server.handle(body));
      },
    });
    expect(outcome).toEqual({ ok: "queued" });
    expect(requests).toBe(0);
    // The queue uploads in order: the clock-in, then the clock-out, both recorded.
    for (const m of queue) expect(server.handle(m.payload).status).toBe(200);
    expect([...server.recorded.values()]).toEqual(["In", "Out"]);
  });

  it("finds only a pending punch of the same worker in the queue", () => {
    const payload = punchFor(avery).payload;
    expect(hasQueuedPunch([{ table: "kiosk_punches", status: "pending", payload }], "m1")).toBe(
      true,
    );
    expect(hasQueuedPunch([{ table: "kiosk_punches", status: "pending", payload }], "m2")).toBe(
      false,
    );
    expect(hasQueuedPunch([{ table: "kiosk_punches", status: "conflict", payload }], "m1")).toBe(
      false,
    );
    expect(hasQueuedPunch([{ table: "time_entries", status: "pending", payload }], "m1")).toBe(
      false,
    );
  });

  it("builds no second punch for a second tap while the first is on its way", async () => {
    const server = punchServer();
    const flight = singleFlight();
    let built = 0;
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tap = () =>
      flight.run(async () => {
        built += 1;
        const punch = punchFor(avery, `0193a000-0000-7000-8000-00000000000${built}`);
        return submitKioskPunch(punch, {
          online: true,
          enqueue: () => Promise.resolve(),
          post: async (body) => {
            await slow;
            return server.handle(body);
          },
        });
      });
    const first = tap();
    expect(flight.busy()).toBe(true);
    const second = tap();
    const third = tap();
    release();
    expect(await first).toEqual({ ok: true });
    expect(await second).toBeUndefined();
    expect(await third).toBeUndefined();
    expect(built).toBe(1);
    expect(server.recorded.size).toBe(1);
    // The next tap, after the first finished, runs.
    expect(flight.busy()).toBe(false);
    expect(await flight.run(() => Promise.resolve("ran"))).toBe("ran");
  });

  it("frees the kiosk for the next punch when a punch throws", async () => {
    const flight = singleFlight();
    await expect(flight.run(() => Promise.reject(new Error("storage full")))).rejects.toThrow(
      "storage full",
    );
    expect(flight.busy()).toBe(false);
  });
});

describe("4.19: a kiosk request has a time limit", () => {
  it("returns the answer when it comes in time", async () => {
    expect(await withSendTimeout(() => Promise.resolve("answer"), 50)).toBe("answer");
  });

  it("aborts the request and rejects when the limit passes", async () => {
    let aborted = false;
    await expect(
      withSendTimeout((signal) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise(() => undefined);
      }, 10),
    ).rejects.toBeInstanceOf(KioskSendTimeout);
    expect(aborted).toBe(true);
  });

  it("passes a failed request through", async () => {
    await expect(
      withSendTimeout(() => Promise.reject(new TypeError("Network request failed")), 50),
    ).rejects.toThrow("Network request failed");
  });
});

describe("4.19: only a rejected PIN is a wrong PIN", () => {
  const pin: KioskStep = { kind: "pin", worker: avery, digits: "1234", attemptsLeft: 5 };

  it("maps every reason app.kiosk_punch answers", () => {
    expect(refusalFromServer("kiosk_pin_rejected")).toBe("pin-invalid");
    expect(refusalFromServer("kiosk_rate_limited")).toBe("rate-limited");
    expect(refusalFromServer("kiosk_device_unregistered")).toBe("device-unregistered");
    expect(refusalFromServer("kiosk_disabled")).toBe("kiosk-disabled");
    expect(refusalFromServer("kiosk_photo_uri")).toBe("photo-required");
    expect(refusalFromServer("punch_photo_required")).toBe("photo-required");
    expect(refusalFromServer("punch_already_in")).toBe("already-in");
    expect(refusalFromServer("punch_not_in")).toBe("not-in");
    for (const reason of [
      "kiosk_project",
      "punch_shift_not_accepted",
      "punch_id_conflict",
      "punch_refused",
    ])
      expect(refusalFromServer(reason)).toBe("punch-refused");
  });

  it("spends no PIN attempt on a refusal of the punch itself", () => {
    expect(afterServer(pin, { ok: false, reason: "punch_already_in" })).toEqual({
      kind: "refused",
      worker: avery,
      reason: "already-in",
    });
    expect(afterServer(pin, { ok: false, reason: "punch_not_in" })).toMatchObject({
      kind: "refused",
      reason: "not-in",
    });
    expect(afterServer(pin, { ok: false, reason: "kiosk_project" })).toMatchObject({
      kind: "refused",
      reason: "punch-refused",
    });
    expect(afterServer(pin, { ok: false, reason: "kiosk_rate_limited" })).toMatchObject({
      kind: "refused",
      reason: "rate-limited",
    });
    expect(afterServer(pin, { ok: false, reason: "kiosk_pin_rejected" })).toEqual({
      ...pin,
      digits: "",
      attemptsLeft: 4,
    });
  });

  it("returns a wrong PIN on a photo punch to the keypad instead of calling the PIN locked", () => {
    const photo: KioskStep = { kind: "photo", worker: avery, digits: "1234", attemptsLeft: 5 };
    expect(afterServer(photo, { ok: false, reason: "kiosk_pin_rejected" })).toEqual({
      kind: "pin",
      worker: avery,
      digits: "",
      attemptsLeft: 4,
    });
    expect(
      afterServer({ ...photo, attemptsLeft: 1 }, { ok: false, reason: "kiosk_pin_rejected" }),
    ).toMatchObject({ kind: "refused", reason: "pin-locked" });
  });
});

describe("4.19: the kiosk offers the right action before the next sync", () => {
  const roster = [avery, riley];

  it("offers clock out to a worker it just clocked in, and clock in after a clock out", () => {
    let known = learnShift({}, "m1", "In", { ok: true }, 1_000);
    known = learnShift(known, "m2", "Out", { ok: true }, 1_000);
    const laid = rosterWithKnowledge(roster, known, 2_000);
    expect(laid.roster.map((r) => r.onShift)).toEqual([true, false]);
    expect(laid.known).toBe(known);
    expect(pickWorker(must(laid.roster[0]))).toMatchObject({ kind: "pin" });
  });

  it("learns from the server that a worker is already in, or not in", () => {
    const already = learnShift({}, "m1", "In", { ok: false, reason: "punch_already_in" }, 1_000);
    expect(rosterWithKnowledge(roster, already, 2_000).roster[0]).toMatchObject({ onShift: true });
    const notIn = learnShift({}, "m2", "Out", { ok: false, reason: "punch_not_in" }, 1_000);
    expect(rosterWithKnowledge(roster, notIn, 2_000).roster[1]).toMatchObject({ onShift: false });
  });

  it("learns from a queued punch, and nothing from a wrong PIN or a break", () => {
    expect(learnShift({}, "m1", "In", { ok: "queued" }, 1_000)).toEqual({
      m1: { onShift: true, atMs: 1_000 },
    });
    const none = {};
    expect(learnShift(none, "m1", "In", { ok: false, reason: "kiosk_pin_rejected" }, 1_000)).toBe(
      none,
    );
    expect(learnShift(none, "m2", "Break Start", { ok: true }, 1_000)).toBe(none);
  });

  it("forgets what the synced rows now agree with, and what is too old", () => {
    const known = learnShift({}, "m1", "In", { ok: true }, 1_000);
    const synced = [{ ...avery, onShift: true }, riley];
    expect(rosterWithKnowledge(synced, known, 2_000).known).toEqual({});
    const old = rosterWithKnowledge(roster, known, 1_000 + KIOSK_KNOWLEDGE_MS);
    expect(old.known).toEqual({});
    expect(old.roster[0]).toMatchObject({ onShift: false });
  });
});

describe("4.19: the kiosk wakes the function while a PIN is typed", () => {
  it("pings at most once per interval and ignores a failed ping", async () => {
    let pings = 0;
    let at = 0;
    const warm = kioskWarmer(
      () => {
        pings += 1;
        return Promise.reject(new TypeError("Network request failed"));
      },
      () => at,
      60_000,
    );
    warm();
    warm();
    at = 59_999;
    warm();
    expect(pings).toBe(1);
    at = 60_000;
    warm();
    expect(pings).toBe(2);
    await Promise.resolve();
  });
});

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a value");
  return value;
}
