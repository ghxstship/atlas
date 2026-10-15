import { describe, expect, it } from "vitest";
import { createCallerClient } from "../src/client";

describe("createCallerClient", () => {
  it("sends the caller's token on every request and reads the app schema", async () => {
    const seen: { url: string; authorization: string | null; profile: string | null }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: String(input),
        authorization: headers.get("authorization"),
        profile: headers.get("accept-profile"),
      });
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    };
    const db = createCallerClient({
      url: "http://supabase.test",
      anonKey: "anon-key-for-tests-0000",
      accessToken: "caller.jwt.token",
      fetch: fetcher,
    });
    const { error } = await db.from("people").select("id");
    expect(error).toBeNull();
    expect(seen[0]?.url).toContain("/rest/v1/people");
    expect(seen[0]?.authorization).toBe("Bearer caller.jwt.token");
    expect(seen[0]?.profile).toBe("app");
  });

  it("works without a custom fetch", () => {
    const db = createCallerClient({
      url: "http://supabase.test",
      anonKey: "anon-key-for-tests-0000",
      accessToken: "caller.jwt.token",
    });
    expect(typeof db.from).toBe("function");
  });
});
