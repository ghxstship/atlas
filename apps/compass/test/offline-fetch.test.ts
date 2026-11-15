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
