import { COMPASS_AURORA_ENTRY } from "@xos/ai/conversation";
import { getMessages, locales } from "@xos/i18n";
import { describe, expect, it } from "vitest";
import { auroraBaseUrl, compassAuroraClient, compassConversation } from "../src/runtime/aurora";

const session = (token: string | null) => ({
  auth: {
    getSession: () =>
      Promise.resolve({ data: { session: token ? { access_token: token } : null }, error: null }),
  },
});

describe("Compass Aurora client", () => {
  it("calls Atlas's public API with the person's session token", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetchImpl = ((url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get("authorization") });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            enabled_features: ["assistant"],
            used: 1,
            allowance: 100,
            plan_includes_aurora: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }) as unknown as typeof fetch;
    const client = compassAuroraClient(
      "https://atlas.example.test/",
      session("jwt-1") as never,
      fetchImpl,
    );
    const status = await client.status();
    expect(status.ok).toBe(true);
    expect(seen).toEqual([
      { url: "https://atlas.example.test/api/v1/aurora/status", auth: "Bearer jwt-1" },
    ]);
  });

  it("sends no authorization header when signed out, and starts a conversation loading", () => {
    expect(auroraBaseUrl("http://localhost:3000")).toBe("http://localhost:3000/api/v1");
    const conversation = compassConversation("http://localhost:3000", session(null) as never);
    expect(conversation.getSnapshot().availability).toEqual({ kind: "loading" });
    expect(conversation.getSnapshot().turns).toEqual([]);
  });

  it("has the menu entry and the Compass copy in every locale", () => {
    expect(COMPASS_AURORA_ENTRY.route).toBe("/more/aurora");
    for (const locale of locales) {
      const m = getMessages(locale);
      expect(m.aurora.compass.menuLabel.length).toBeGreaterThan(0);
      expect(m.compass.aurora.limit).toContain("{allowance}");
      expect(m.compass.logistics.dock.checkIn.length).toBeGreaterThan(0);
    }
  });
});
