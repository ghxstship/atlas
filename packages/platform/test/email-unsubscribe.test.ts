import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The email-unsubscribe function's stakeholder pack branch (B2, ADR 0141). A provider's RFC 8058 POST has no Origin,
 * which the Atlas proxy would refuse, so it stops here; a GET goes to Atlas's confirm page without acting, because mail
 * scanners follow links. Tokens of the existing shape still reach unsubscribe_by_token.
 */
const rpc = vi.fn<(fn: string, args: Record<string, unknown>) => Promise<unknown>>();
let handler: (request: Request) => Promise<Response>;

vi.mock("../../../supabase/functions/_shared/runtime.ts", () => ({
  env: (name: string) => (name === "XOS_APP_URL" ? "https://atlas.test" : ""),
  json: (status: number, body: unknown) => new Response(JSON.stringify(body), { status }),
  serve: (h: (request: Request) => Promise<Response>) => {
    handler = h;
  },
  serviceDb: () => ({ rpc }),
}));

const PACK = `xpku_${"ab".repeat(32)}`;
const url = (token: string) => `https://fn.test/functions/v1/email-unsubscribe?token=${token}`;

describe("email-unsubscribe with a stakeholder pack token", () => {
  beforeEach(async () => {
    rpc.mockReset();
    await import("../../../supabase/functions/email-unsubscribe/index.ts");
  });

  it("answers a POST with no Origin 204 and stops the emails", async () => {
    rpc.mockResolvedValue(true);
    const response = await handler(new Request(url(PACK), { method: "POST" }));
    expect(response.status).toBe(204);
    expect(rpc).toHaveBeenCalledWith("unsubscribe_pack_by_token", { p_token: PACK });
  });

  it("answers 404 for an unknown token", async () => {
    rpc.mockResolvedValue(false);
    expect((await handler(new Request(url(PACK), { method: "POST" }))).status).toBe(404);
  });

  it("sends a GET to the confirm page without acting", async () => {
    const response = await handler(new Request(url(PACK)));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `https://atlas.test/share/pack/unsubscribe/${PACK}`,
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it("still sends a token of the existing shape to unsubscribe_by_token", async () => {
    rpc.mockResolvedValue("northwind");
    const response = await handler(new Request(url("a.b.all.c"), { method: "POST" }));
    expect(response.status).toBe(204);
    expect(rpc).toHaveBeenCalledWith("unsubscribe_by_token", { p_token: "a.b.all.c" });
  });
});
