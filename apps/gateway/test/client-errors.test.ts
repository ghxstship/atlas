import { routeTemplate } from "@xos/infra/observability/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_ERROR_ROUTES } from "@/lib/client-error-routes";
import { ClientErrorSchema } from "@/lib/client-errors";

/**
 * POST /api/client-errors (ADR 0025): validation, rate limit, redaction, and no Sentry call or
 * network request without a DSN. `@sentry/nextjs` is replaced so the test never reaches Sentry.
 */
const sentry = vi.hoisted(() => ({
  captureException: vi.fn(),
  flush: vi.fn(async () => true),
  init: vi.fn(),
}));
vi.mock("@sentry/nextjs", () => sentry);

const SITE = "http://127.0.0.1:3001";
const DSN = "https://publickey@o1.ingest.us.sentry.io/4500000000000001";

const valid = {
  message: "TypeError: cannot read properties of undefined for ada@example.com",
  stack: "at render (http://127.0.0.1:3001/_next/static/chunks/app.js:1:2345)",
  route: "/work/engagements/[engagementKey]",
  source: "window",
  release: "abc123",
  userId: "4f1c2e7a-0000-4000-8000-000000000001",
};

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${SITE}/api/client-errors`, {
    method: "POST",
    headers: { origin: SITE, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function loadRoute(dsn?: string) {
  vi.resetModules();
  vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:55421");
  vi.stubEnv("SUPABASE_ANON_KEY", "anon-key-for-tests-0000000000");
  vi.stubEnv("GATEWAY_SITE_URL", SITE);
  vi.stubEnv("SENTRY_DSN", dsn ?? "");
  vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
  vi.stubEnv("XOS_LOG_LEVEL", "error");
  return import("@/app/api/client-errors/route");
}

let fetchSpy: ReturnType<typeof vi.spyOn>;
let logged: string[];

beforeEach(() => {
  vi.clearAllMocks();
  fetchSpy = vi.spyOn(globalThis, "fetch");
  logged = [];
  vi.spyOn(console, "error").mockImplementation((line: string) => {
    logged.push(String(line));
  });
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/client-errors without a DSN", () => {
  it("answers 204, logs the redacted error and never calls Sentry", async () => {
    const { POST } = await loadRoute();
    const response = await POST(post(valid));
    expect(response.status).toBe(204);
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(sentry.flush).not.toHaveBeenCalled();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('"runtime":"browser"');
    expect(logged.join("\n")).not.toContain("ada@example.com");
  });
});

describe("POST /api/client-errors with a DSN", () => {
  it("reports through the server Sentry client, tagged runtime:browser, with the user id", async () => {
    const { POST } = await loadRoute(DSN);
    const response = await POST(post(valid));
    expect(response.status).toBe(204);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    const [error, hint] = sentry.captureException.mock.calls[0] ?? [];
    expect((error as Error).name).toBe("BrowserError");
    expect((error as Error).message).toBe(
      "TypeError: cannot read properties of undefined for [email]",
    );
    expect(hint).toMatchObject({
      tags: { runtime: "browser", route: "/work/engagements/[engagementKey]", source: "window" },
      user: { id: valid.userId },
    });
    expect(sentry.flush).toHaveBeenCalledTimes(1);
  });

  it("refuses payloads the schema rejects", async () => {
    const { POST } = await loadRoute(DSN);
    const refused = [
      { ...valid, route: "/sign/abc?token=abc" },
      { ...valid, userId: "ada@example.com" },
      { ...valid, source: "console" },
      { ...valid, formValues: { password: "x" } },
      { ...valid, message: "" },
    ];
    for (const body of refused) expect((await POST(post(body))).status).toBe(400);
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("refuses cross-origin posts", async () => {
    const { POST } = await loadRoute(DSN);
    expect((await POST(post(valid, { origin: "https://evil.example" }))).status).toBe(403);
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("allows 10 reports a minute per caller, then answers 429", async () => {
    const { POST } = await loadRoute(DSN);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      statuses.push((await POST(post(valid, { "x-forwarded-for": "198.51.100.7" }))).status);
    }
    expect(statuses.filter((s) => s === 204)).toHaveLength(10);
    expect(statuses.slice(10)).toEqual([429, 429]);
    expect((await POST(post(valid, { "x-forwarded-for": "198.51.100.8" }))).status).toBe(204);
  });
});

describe("ClientErrorSchema and route templates", () => {
  it("accepts every template the browser reporter produces, and never a token", () => {
    const paths = [
      "/home",
      "/advance/Zk3pQ9sX7aB2cD4eF6gH8jK0",
      "/sign/abc",
      "/u/ada",
      "/c/acme-staging",
      "/messages/THR-12",
      "/explore/OPP-7",
      "/work/engagements/ENG-3/documents",
      "/auth/sign-in",
    ];
    const templates = paths.map((p) => routeTemplate(p, CLIENT_ERROR_ROUTES));
    expect(templates).toEqual([
      "/home",
      "/advance/[token]",
      "/sign/[token]",
      "/u/[handle]",
      "/c/[companyHandle]",
      "/messages/[threadKey]",
      "/explore/[opportunityKey]",
      "/work/engagements/[engagementKey]/documents",
      "/auth/sign-in",
    ]);
    for (const route of templates) {
      expect(ClientErrorSchema.safeParse({ ...valid, route }).success).toBe(true);
    }
  });
});
