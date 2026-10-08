import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /api/v1/openapi.json", () => {
  it("serves the generated OpenAPI 3.1 document", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(body.openapi).toBe("3.1.0");
    expect(Object.keys(body.paths).length).toBeGreaterThan(500);
  });
});
