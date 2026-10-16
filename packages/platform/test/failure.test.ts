import { describe, expect, it } from "vitest";
import { createLogger } from "../../../infra/observability/src/logger.ts";
import { edgeFunctionName, internalErrorResponse, requestIdFor } from "../src/index.ts";

describe("Edge Function failures (A22-013)", () => {
  it("returns a generic problem with a request id and none of the error's text", async () => {
    const lines: string[] = [];
    const logger = createLogger({
      service: "edge.kiosk-punch",
      environment: "test",
      sink: (line) => lines.push(line),
    });
    const secretError = new Error(
      'STRIPE_WEBHOOK_SECRET is not set; relation "app.people" for owner@example.com',
    );
    const response = internalErrorResponse(secretError, {
      requestId: "req-12345678",
      logger,
      fn: "kiosk-punch",
    });

    expect(response.status).toBe(500);
    expect(response.headers.get("X-Request-Id")).toBe("req-12345678");
    expect(response.headers.get("Content-Type")).toBe("application/problem+json");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      type: "/problems/internal",
      title: "Internal error",
      status: 500,
      detail: "The request could not be completed. Quote request id req-12345678 to support.",
      request_id: "req-12345678",
    });
    expect(JSON.stringify(body)).not.toMatch(/STRIPE|app\.people|example\.com/);

    // The detail is logged server side, with the request id, through the redactor.
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(record["request_id"]).toBe("req-12345678");
    expect(record["function"]).toBe("kiosk-punch");
    expect(JSON.stringify(record["error"])).toContain("STRIPE_WEBHOOK_SECRET is not set");
    expect(JSON.stringify(record)).not.toContain("owner@example.com");
    expect(JSON.stringify(record)).toContain("[email]");
  });

  it("still answers when the logger throws", async () => {
    const response = internalErrorResponse("boom", {
      requestId: "req-abcdefgh",
      logger: {
        error() {
          throw new Error("sink down");
        },
      },
    });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("boom");
  });

  it("keeps a well-formed caller request id and replaces anything else", () => {
    const withId = new Request("https://x.test/functions/v1/api-token", {
      headers: { "X-Request-Id": "trace-0001-abcd" },
    });
    expect(requestIdFor(withId, () => "generated")).toBe("trace-0001-abcd");
    const injected = new Request("https://x.test/", {
      headers: { "X-Request-Id": "<script>alert(1)</script>" },
    });
    expect(requestIdFor(injected, () => "generated")).toBe("generated");
    expect(requestIdFor(new Request("https://x.test/"), () => "generated")).toBe("generated");
    expect(requestIdFor(new Request("https://x.test/"))).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("names the function from its URL", () => {
    expect(edgeFunctionName("https://p.supabase.co/functions/v1/kiosk-punch")).toBe("kiosk-punch");
    expect(edgeFunctionName("http://localhost:9000/stripe-webhook/extra")).toBe("stripe-webhook");
    expect(edgeFunctionName("http://localhost:9000/")).toBe("unknown");
    expect(edgeFunctionName("http://localhost:9000/Bad%20Name")).toBe("unknown");
  });
});
