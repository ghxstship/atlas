import { beforeAll, describe, expect, it, vi } from "vitest";

// lib/api/app.ts (B16) is server-only; vitest runs outside Next's server bundle.
vi.mock("server-only", () => ({}));

beforeAll(() => {
  process.env["SUPABASE_URL"] = "http://127.0.0.1:1";
  process.env["SUPABASE_ANON_KEY"] = "anon-key-for-route-tests-0000";
  process.env["ATLAS_SITE_URL"] = "http://localhost:3000";
});

// The first import builds the whole v1 app (1,307 routes), which outlasts the 5 s default on CI runners.
describe("/api/v1/[...path]", { timeout: 30_000 }, () => {
  it("serves mounted operations and answers 401 without a credential", async () => {
    const { GET } = await import("./route");
    const res = await GET(new Request("http://localhost:3000/api/v1/canon/departments"));
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(((await res.json()) as { instance: string }).instance).toBe("/api/v1/canon/departments");
  });

  it("serves the API host's /v1 paths, which keep their path after the proxy rewrite", async () => {
    const { GET } = await import("./route");
    const res = await GET(
      new Request("http://localhost:3000/v1/canon/departments", {
        headers: { host: "api.localhost:3000" },
      }),
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { instance: string }).instance).toBe("/v1/canon/departments");
  });

  it("answers 404 for a path no operation serves", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      new Request("http://localhost:3000/api/v1/no-such-resource", { method: "POST" }),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { type: string }).type).toBe("/problems/not-found");
  });
});
