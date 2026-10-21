import { describe, expect, it } from "vitest";
import { KIOSK_SEND_ATTEMPTS, sendKioskPunch } from "../src/domain/kiosk";

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
