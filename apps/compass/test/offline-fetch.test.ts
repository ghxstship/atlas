import { describe, expect, it, vi } from "vitest";
import { isServerUnreachable } from "../src/data/identity";
import { offlineAwareFetch } from "../src/data/offlineFetch";

describe("offlineAwareFetch", () => {
  it("fails at once, as an unreachable server, while the device is offline", async () => {
    const base = vi.fn<typeof fetch>();
    const request = offlineAwareFetch(async () => false, base);
    const error = await request("http://10.0.2.2:55421/rest/v1/rpc/x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(isServerUnreachable((error as Error).message)).toBe(true);
    expect(base).not.toHaveBeenCalled();
  });

  it("passes the request through while connected, or when the reading fails", async () => {
    const response = new Response("ok");
    const base = vi.fn<typeof fetch>().mockResolvedValue(response);
    await expect(offlineAwareFetch(async () => true, base)("http://x/a")).resolves.toBe(response);
    await expect(
      offlineAwareFetch(() => Promise.reject(new Error("no reading")), base)("http://x/b"),
    ).resolves.toBe(response);
    expect(base).toHaveBeenCalledTimes(2);
  });
});

describe("offlineAwareFetch time limit", () => {
  /** A request the server never answers; it rejects only when its signal aborts, as fetch does. */
  const hanging = vi.fn<typeof fetch>(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("Aborted")));
      }),
  );

  it("fails a request with no response within the limit, as an unreachable server", async () => {
    vi.useFakeTimers();
    try {
      const request = offlineAwareFetch(async () => true, hanging, 1_000);
      const pending = request("http://10.0.2.2:55421/rest/v1/rpc/x", {
        method: "POST",
        body: "{}",
      }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1_000);
      const error = await pending;
      expect(error).toBeInstanceOf(TypeError);
      expect(isServerUnreachable((error as Error).message)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the caller's own cancellation", async () => {
    const caller = new AbortController();
    const pending = offlineAwareFetch(
      async () => true,
      hanging,
      60_000,
    )("http://x/c", {
      signal: caller.signal,
    }).catch((e: unknown) => e);
    await Promise.resolve();
    await Promise.resolve();
    caller.abort();
    const error = await pending;
    expect((error as Error).message).toBe("Aborted");
  });

  it("sets no limit on a file upload", async () => {
    const response = new Response("ok");
    const base = vi.fn<typeof fetch>().mockResolvedValue(response);
    const body = new Blob(["photo"]);
    await expect(
      offlineAwareFetch(
        async () => true,
        base,
        1,
      )("http://x/storage/v1/object/a", {
        method: "POST",
        body,
      }),
    ).resolves.toBe(response);
    expect(base.mock.calls[0]?.[1]?.signal).toBeUndefined();
  });
});
