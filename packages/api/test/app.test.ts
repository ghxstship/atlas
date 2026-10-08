import { describe, expect, it } from "vitest";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createApiApp, problemResponse, toPointer, validationHook } from "../src/index.ts";
import { camelFromPath, labelFromName, resource } from "../src/catalog/define.ts";
import { buildRoutes } from "../src/build/routes.ts";
import { registerParameters } from "../src/conventions/components.ts";
import { identity } from "@xos/schemas";

describe("app factory", () => {
  it("mounts no unimplemented operation handlers", async () => {
    const app = createApiApp();
    expect(app.routes).toHaveLength(0);
    const res = await app.request("/projects");
    expect(res.status).toBe(404);
  });
});

describe("problem details", () => {
  it("serves problem+json", async () => {
    const res = problemResponse({ type: "/problems/not-found", title: "Not Found", status: 404 });
    expect(res.headers.get("Content-Type")).toBe("application/problem+json");
    expect(((await res.json()) as { status: number }).status).toBe(404);
  });

  it("escapes JSON Pointer segments", () => {
    expect(toPointer(["a/b", "c~d", 0])).toBe("/a~1b/c~0d/0");
  });

  it("turns validation failures into 422 problems", async () => {
    const app = new OpenAPIHono({ defaultHook: validationHook });
    const route = createRoute({
      method: "post",
      path: "/things",
      request: {
        body: { content: { "application/json": { schema: z.object({ title: z.string() }) } } },
      },
      responses: { 200: { description: "ok" } },
    });
    app.openapi(route, (c) => c.json({ ok: true }, 200));
    const bad = await app.request("/things", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(422);
    const body = (await bad.json()) as { errors: { pointer: string }[] };
    expect(body.errors[0]?.pointer).toBe("/title");
    const good = await app.request("/things", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(good.status).toBe(200);
  });
});

describe("catalog helpers", () => {
  it("derives operation names and labels", () => {
    expect(camelFromPath("/purchase-orders")).toBe("purchaseOrders");
    expect(camelFromPath("/canon/gate-criteria")).toBe("canonGateCriteria");
    expect(camelFromPath("/objects/{object_key}")).toBe("objects");
    expect(labelFromName("PurchaseOrder")).toBe("purchase order");
  });

  it("refuses create or update on resources that cannot accept them", () => {
    const params = registerParameters(new OpenAPIHono().openAPIRegistry);
    expect(() =>
      buildRoutes([resource("Identity", "/me", identity.Me, { verbs: ["create"] })], params),
    ).toThrow(/read-only/);
    expect(() =>
      buildRoutes([resource("Identity", "/blocks", identity.Block, { verbs: ["update"] })], params),
    ).toThrow(/no updatable/);
  });
});
