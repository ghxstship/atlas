import { describe, expect, it } from "vitest";
import { parseEnv } from "../lib/env";
import { appleAssociationFile, assetLinksFile, handoffLink } from "../lib/handoff";

/** Continue on another device (ADR 0030): Gateway's QR link and universal link files. */
const base = {
  SUPABASE_URL: "http://127.0.0.1:57121",
  SUPABASE_ANON_KEY: "a".repeat(40),
  GATEWAY_SITE_URL: "https://gateway.example.test",
};
const engagement = { kind: "engagement", engagementKey: "E-ABC123" } as const;

describe("Gateway handoff", () => {
  it("carries the compass:// link until universal links are configured", () => {
    const config = parseEnv(base);
    expect(handoffLink(engagement, config)).toEqual({
      url: "compass://e/E-ABC123",
      universal: false,
    });
    expect(appleAssociationFile(config).status).toBe(404);
    expect(assetLinksFile(config).status).toBe(404);
  });

  it("claims the engagement pages for Compass once configured", async () => {
    const config = parseEnv({ ...base, COMPASS_APPLE_TEAM_IDS: "ABCDE12345" });
    expect(handoffLink(engagement, config).url).toBe(
      "https://gateway.example.test/work/engagements/E-ABC123",
    );
    expect(await appleAssociationFile(config).json()).toMatchObject({
      applinks: { details: [{ components: [{ "/": "/work/engagements/*" }] }] },
    });
    expect(assetLinksFile(config).status).toBe(404);
  });
});
