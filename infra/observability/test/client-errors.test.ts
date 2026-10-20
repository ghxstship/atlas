import { describe, expect, it, vi } from "vitest";
import {
  MAX_CLIENT_ERROR_BYTES,
  clientKey,
  createClientErrorHandler,
  createErrorReporter,
  createLogger,
  createRateLimiter,
  toBrowserError,
  type ClientErrorReport,
  type ErrorSink,
} from "../src/index.ts";

/** The value, or a thrown error naming what was missing. */
function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("expected a value");
  return value;
}

const SITE = "https://atlas.example";

/** A hand-written stand-in for the app's zod schema: accepts objects with a string message. */
function parse(input: unknown): { success: true; data: ClientErrorReport } | { success: false } {
  if (typeof input !== "object" || input === null) return { success: false };
  const record = input as Record<string, unknown>;
  if (typeof record["message"] !== "string" || typeof record["route"] !== "string") {
    return { success: false };
  }
  return { success: true, data: record as unknown as ClientErrorReport };
}

function setup(options: { sink?: ErrorSink; limit?: number; flush?: () => Promise<unknown> } = {}) {
  const lines: string[] = [];
  const logger = createLogger({
    service: "atlas",
    environment: "test",
    sink: (l) => lines.push(l),
  });
  const errors = createErrorReporter({ logger, sink: options.sink });
  const handler = createClientErrorHandler({
    errors,
    parse,
    limiter: createRateLimiter({ limit: options.limit ?? 10, globalLimit: 100, windowMs: 60_000 }),
    siteOrigin: SITE,
    flush: options.flush,
  });
  return { handler, lines };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${SITE}/api/client-errors`, {
    method: "POST",
    headers: { origin: SITE, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const valid = {
  message: "TypeError: failed for ada@example.com",
  stack:
    "at f (https://atlas.example/_next/static/chunks/a.js:1:2)\nat g (https://atlas.example/x.js?token=abc:3:4)",
  route: "/[org]/home?email=ada@example.com",
  source: "window",
  release: "abc123",
  userId: "4f1c2e7a-0000-4000-8000-000000000001",
};

describe("createClientErrorHandler", () => {
  it("reports a redacted browser error through the sink, tagged runtime:browser", async () => {
    const captureException = vi.fn();
    const flush = vi.fn(async () => true);
    const { handler, lines } = setup({ sink: { captureException }, flush });
    const response = await handler(post(valid, { "x-forwarded-for": "203.0.113.9" }));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(flush).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledTimes(1);
    const [error, hint] = must(captureException.mock.calls[0]);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("BrowserError");
    expect(error.message).toBe("TypeError: failed for [email]");
    expect(error.stack).not.toContain("token=abc");
    expect(error.stack).toContain("a.js:1:2");
    expect(hint).toEqual({
      tags: {
        runtime: "browser",
        source: "window",
        route: "/[org]/home",
        browser_release: "abc123",
      },
      extra: {},
      user: { id: "4f1c2e7a-0000-4000-8000-000000000001" },
    });
    const all = lines.join("\n");
    expect(all).not.toContain("ada@example.com");
    expect(all).not.toContain("203.0.113.9");
  });

  it("is a log-only no-op without a sink (no DSN)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { handler, lines } = setup();
    const response = await handler(
      post({ ...valid, userId: undefined, release: undefined, stack: undefined }),
    );
    expect(response.status).toBe(204);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(must(lines[0]))).toMatchObject({
      level: "error",
      message: "unhandled error",
    });
    fetchSpy.mockRestore();
  });

  it("refuses other origins and requests without an Origin", async () => {
    const captureException = vi.fn();
    const { handler } = setup({ sink: { captureException } });
    expect((await handler(post(valid, { origin: "https://evil.example" }))).status).toBe(403);
    const bare = new Request(`${SITE}/api/client-errors`, { method: "POST", body: "{}" });
    expect((await handler(bare)).status).toBe(403);
    expect(captureException).not.toHaveBeenCalled();
  });

  it("accepts the configured site origin when the request URL differs", async () => {
    const { handler } = setup();
    const request = new Request("http://127.0.0.1:3000/api/client-errors", {
      method: "POST",
      headers: { origin: SITE },
      body: JSON.stringify(valid),
    });
    expect((await handler(request)).status).toBe(204);
  });

  it("refuses invalid JSON and payloads the schema rejects", async () => {
    const captureException = vi.fn();
    const { handler } = setup({ sink: { captureException } });
    expect((await handler(post("{not json"))).status).toBe(400);
    expect((await handler(post({ message: 42 }))).status).toBe(400);
    expect((await handler(post(null))).status).toBe(400);
    expect(captureException).not.toHaveBeenCalled();
  });

  it("refuses bodies over 8 KB, declared or actual", async () => {
    const { handler } = setup();
    const big = JSON.stringify({ ...valid, message: "x".repeat(MAX_CLIENT_ERROR_BYTES) });
    expect((await handler(post(big, { "content-length": String(big.length) }))).status).toBe(413);
    expect((await handler(post(big))).status).toBe(413);
  });

  it("rate-limits each caller", async () => {
    const captureException = vi.fn();
    const { handler } = setup({ sink: { captureException }, limit: 2 });
    const from = (ip: string, spoofed = "10.0.0.1") =>
      post(valid, { "x-forwarded-for": `${spoofed}, ${ip}` });
    expect((await handler(from("198.51.100.1"))).status).toBe(204);
    expect((await handler(from("198.51.100.1", "203.0.113.1"))).status).toBe(204);
    // A69-003: a new first entry is the client's own text and buys no fresh limit.
    expect((await handler(from("198.51.100.1", "203.0.113.2"))).status).toBe(429);
    expect((await handler(from("198.51.100.2"))).status).toBe(204);
    expect(captureException).toHaveBeenCalledTimes(3);
  });
});

describe("createRateLimiter", () => {
  it("caps each key and the total per window, then resets", () => {
    let t = 0;
    const limiter = createRateLimiter({ limit: 2, globalLimit: 3, windowMs: 1000, now: () => t });
    expect([limiter.take("a"), limiter.take("a"), limiter.take("a")]).toEqual([true, true, false]);
    expect([limiter.take("b"), limiter.take("c")]).toEqual([true, false]);
    t = 1000;
    expect(limiter.take("a")).toBe(true);
  });
});

describe("clientKey and toBrowserError", () => {
  it("keys on the address the proxy appended, then x-real-ip", () => {
    expect(clientKey(new Headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }))).toBe("2.2.2.2");
    expect(clientKey(new Headers({ "x-real-ip": "3.3.3.3" }))).toBe("3.3.3.3");
    expect(clientKey(new Headers())).toBe("unknown");
  });

  it("builds a stack-less error when the payload has no frames", () => {
    const error = toBrowserError({ message: "boom", route: "/", source: "boundary" });
    expect(error.stack).toBe("BrowserError: boom");
  });
});
