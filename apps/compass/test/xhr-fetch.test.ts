import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isServerUnreachable } from "../src/data/identity";
import { offlineAwareFetch } from "../src/data/offlineFetch";
import { createXhrFetch, type XhrLike } from "../src/data/xhrFetch";

/** How a fake server answers: when its headers arrive, how the body trickles in, or never. */
interface Script {
  readonly headersAfterMs?: number;
  readonly chunks?: number;
  readonly chunkEveryMs?: number;
  readonly status?: number;
  readonly body?: string;
}

/** A stand-in for React Native's XMLHttpRequest, driven by fake timers. */
function fakeXhr(script: Script) {
  const opened: FakeXhr[] = [];
  class FakeXhr implements XhrLike {
    readyState = 0;
    status = 0;
    statusText = "";
    responseType = "";
    response: unknown = null;
    responseURL = "";
    onreadystatechange: (() => void) | null = null;
    onprogress: (() => void) | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    onabort: (() => void) | null = null;
    sent: unknown = undefined;
    aborted = false;
    readonly requestHeaders = new Map<string, string>();
    private readonly timers: ReturnType<typeof setTimeout>[] = [];
    method = "";
    url = "";

    constructor() {
      opened.push(this);
    }
    open(method: string, url: string) {
      this.method = method;
      this.url = url;
      this.readyState = 1;
    }
    setRequestHeader(name: string, value: string) {
      this.requestHeaders.set(name, value);
    }
    getAllResponseHeaders() {
      return "content-type: application/json\r\nx-total: 2";
    }
    send(body: unknown) {
      this.sent = body;
      if (script.headersAfterMs === undefined) return; // the server never answers
      const at = (ms: number, step: () => void) => this.timers.push(setTimeout(step, ms));
      at(script.headersAfterMs, () => {
        this.status = script.status ?? 200;
        this.statusText = "OK";
        this.responseURL = this.url;
        this.readyState = 2;
        this.onreadystatechange?.();
      });
      const chunks = script.chunks ?? 0;
      const every = script.chunkEveryMs ?? 0;
      for (let n = 1; n <= chunks; n += 1) {
        at(script.headersAfterMs + n * every, () => {
          this.readyState = 3;
          this.onprogress?.();
        });
      }
      at(script.headersAfterMs + (chunks + 1) * every, () => {
        this.readyState = 4;
        this.response = script.body ?? "";
        this.onload?.();
      });
    }
    abort() {
      this.aborted = true;
      for (const timer of this.timers) clearTimeout(timer);
      this.readyState = 4;
      this.onabort?.();
    }
  }
  return { Xhr: FakeXhr, opened };
}

const online = async () => true;

describe("xhrFetch under the time limit", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("lets a large body that keeps arriving take far longer than the limit", async () => {
    // Headers after 0.8 s, then 40 pieces 0.9 s apart: 37 s in all against a 1 s limit.
    const body = JSON.stringify(
      Array.from({ length: 2_000 }, (_, id) => ({ id, name: `row ${id}` })),
    );
    const { Xhr, opened } = fakeXhr({ headersAfterMs: 800, chunks: 40, chunkEveryMs: 900, body });
    const request = offlineAwareFetch(online, createXhrFetch(Xhr), 1_000);
    const pending = request("http://10.0.2.2:55421/rest/v1/rpc/sync_pull", {
      method: "POST",
      body: "{}",
    });
    await vi.advanceTimersByTimeAsync(40_000);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers.get("x-total")).toBe("2");
    expect(await response.json()).toHaveLength(2_000);
    expect(opened[0]?.aborted).toBe(false);
  });

  it("fails a request the server never answers, as an unreachable server", async () => {
    const { Xhr, opened } = fakeXhr({});
    const request = offlineAwareFetch(online, createXhrFetch(Xhr), 1_000);
    const pending = request("http://10.0.2.2:55421/rest/v1/rpc/x", {
      method: "POST",
      body: "{}",
    }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(999);
    expect(opened[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const error = await pending;
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe("Network request timed out");
    expect(isServerUnreachable((error as Error).message)).toBe(true);
    expect(opened[0]?.aborted).toBe(true);
  });

  it("fails a body that stops arriving for as long as the limit", async () => {
    const { Xhr, opened } = fakeXhr({ headersAfterMs: 100, chunks: 2, chunkEveryMs: 5_000 });
    const request = offlineAwareFetch(online, createXhrFetch(Xhr), 1_000);
    const pending = request("http://x/rest/v1/big").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_200);
    const error = await pending;
    expect((error as Error).message).toBe("Network request timed out");
    expect(opened[0]?.aborted).toBe(true);
  });
});

describe("xhrFetch requests", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends the method, headers and body, and reads the response", async () => {
    const { Xhr, opened } = fakeXhr({ headersAfterMs: 1, body: '{"ok":true}' });
    const pending = createXhrFetch(Xhr)("http://x/rest/v1/a", {
      method: "post",
      headers: { apikey: "k", "Content-Type": "application/json" },
      body: '{"a":1}',
    });
    await vi.advanceTimersByTimeAsync(10);
    const response = await pending;
    const xhr = opened[0];
    expect(xhr?.method).toBe("POST");
    expect(xhr?.url).toBe("http://x/rest/v1/a");
    expect(xhr?.responseType).toBe("blob");
    expect(xhr?.requestHeaders.get("apikey")).toBe("k");
    expect(xhr?.requestHeaders.get("content-type")).toBe("application/json");
    expect(xhr?.sent).toBe('{"a":1}');
    expect(response.url).toBe("http://x/rest/v1/a");
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("gives a no-content response no body", async () => {
    const { Xhr } = fakeXhr({ headersAfterMs: 1, status: 204, body: "" });
    const pending = createXhrFetch(Xhr)("http://x/rest/v1/b", { method: "DELETE" });
    await vi.advanceTimersByTimeAsync(10);
    const response = await pending;
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it("fails as React Native does when the connection fails", async () => {
    const { Xhr, opened } = fakeXhr({});
    const pending = createXhrFetch(Xhr)("http://x/c").catch((e: unknown) => e);
    opened[0]?.onerror?.();
    await vi.advanceTimersByTimeAsync(1);
    const error = await pending;
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe("Network request failed");
  });

  it("aborts with the caller's signal, and refuses one already aborted", async () => {
    const { Xhr, opened } = fakeXhr({});
    const caller = new AbortController();
    const pending = createXhrFetch(Xhr)("http://x/d", { signal: caller.signal }).catch(
      (e: unknown) => e,
    );
    caller.abort();
    await vi.advanceTimersByTimeAsync(1);
    expect(((await pending) as Error).name).toBe("AbortError");
    expect(opened[0]?.aborted).toBe(true);
    const early = await createXhrFetch(Xhr)("http://x/e", { signal: caller.signal }).catch(
      (e: unknown) => e,
    );
    expect((early as Error).name).toBe("AbortError");
    expect(opened).toHaveLength(1);
  });
});
