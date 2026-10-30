import { afterEach, describe, expect, it, vi } from "vitest";
import { signIn } from "../src/session.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("signIn", () => {
  it("asks the local stack's password grant for the demo person's session", async () => {
    vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:64831");
    vi.stubEnv("SUPABASE_ANON_KEY", "anon");
    const fetch = vi.fn(async () => Response.json({ access_token: "a", refresh_token: "r" }));
    vi.stubGlobal("fetch", fetch);
    await expect(signIn("owner@example.com")).resolves.toEqual({
      access_token: "a",
      refresh_token: "r",
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:64831/auth/v1/token?grant_type=password");
    expect(JSON.parse(String(init.body))).toMatchObject({ email: "owner@example.com" });
  });

  it("needs the anon key, and reports a refused sign-in", async () => {
    vi.stubEnv("SUPABASE_ANON_KEY", "");
    await expect(signIn("x@example.com")).rejects.toThrow("SUPABASE_ANON_KEY");
    vi.stubEnv("SUPABASE_ANON_KEY", "anon");
    vi.stubGlobal("fetch", async () => new Response("no", { status: 400 }));
    await expect(signIn("x@example.com")).rejects.toThrow("answered 400: no");
  });
});
