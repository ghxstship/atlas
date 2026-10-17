import { describe, expect, it, vi } from "vitest";
import { observeEdgeFunction } from "../src/edge.ts";

const DSN = "https://publickey@o1.ingest.us.sentry.io/4500000000000001";

function setup(env: Record<string, string>) {
  const lines: Array<Record<string, unknown>> = [];
  const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
  const failure = vi.fn((error: unknown, scope: { requestId: string }) => {
    expect(error).toBeInstanceOf(Error);
    return new Response(JSON.stringify({ request_id: scope.requestId }), { status: 500 });
  });
  const wrap = (handler: (request: Request) => Promise<Response>) =>
    observeEdgeFunction(handler, {
      fn: "kiosk-punch",
      env,
      failure,
      fetch: fetchSpy as unknown as typeof fetch,
      logSink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
      flushMs: 50,
    });
  return { lines, fetchSpy, failure, wrap };
}

const request = () =>
  new Request("https://ref.supabase.co/functions/v1/kiosk-punch?token=abc", {
    method: "POST",
    headers: { "x-request-id": "req-0000-abcd" },
  });

describe("observeEdgeFunction", () => {
  it("logs one completion record and echoes the correlation headers", async () => {
    const { lines, fetchSpy, wrap } = setup({});
    const response = await wrap(async () => new Response(null, { status: 202 }))(request());
    expect(response.status).toBe(202);
    expect(response.headers.get("x-request-id")).toBe("req-0000-abcd");
    expect(response.headers.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      service: "edge.kiosk-punch",
      message: "request completed",
      http_route: "/kiosk-punch",
      request_id: "req-0000-abcd",
    });
    expect(JSON.stringify(lines)).not.toContain("token=abc");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("without SENTRY_DSN, turns a thrown error into the failure response and sends nothing", async () => {
    const { fetchSpy, failure, wrap } = setup({});
    const response = await wrap(async () => {
      throw new Error("insert failed for ada@example.com");
    })(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ request_id: "req-0000-abcd" });
    expect(failure).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("with SENTRY_DSN, sends one scrubbed event before answering", async () => {
    const { fetchSpy, wrap } = setup({ SENTRY_DSN: DSN });
    const response = await wrap(async () => {
      throw new Error("insert failed for ada@example.com");
    })(request());
    expect(response.status).toBe(500);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = String((fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1].body);
    expect(body).toContain('"function":"kiosk-punch"');
    expect(body).toContain('"runtime":"edge-function"');
    expect(body).toContain('"request_id":"req-0000-abcd"');
    expect(body).not.toContain("ada@example.com");
  });

  it("logs a warning when Sentry refuses the event, and still answers", async () => {
    const { lines, wrap, fetchSpy } = setup({ SENTRY_DSN: DSN });
    fetchSpy.mockImplementationOnce(async () => new Response(null, { status: 503 }));
    const response = await wrap(async () => {
      throw new Error("boom");
    })(request());
    expect(response.status).toBe(500);
    expect(lines.some((l) => l["message"] === "sentry event not sent")).toBe(true);
  });
});
