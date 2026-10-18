import { describe, expect, it } from "vitest";
import { parseEnv } from "../lib/env";
import { appleAssociationFile, assetLinksFile, handoffLink } from "../lib/handoff";

/** Continue on another device (ADR 0030): Atlas's QR link and universal link files from the environment. */
const base = {
  SUPABASE_URL: "http://127.0.0.1:57121",
  SUPABASE_ANON_KEY: "a".repeat(40),
  ATLAS_SITE_URL: "https://atlas.example.test",
};
const record = { kind: "record", org: "demo-productions", recordKey: "NWS-12" } as const;

describe("Atlas handoff", () => {
  it("carries the compass:// link until universal links are configured", async () => {
    const config = parseEnv(base);
    expect(handoffLink(record, config)).toEqual({
      url: "compass://r/NWS-12?org=demo-productions",
      universal: false,
    });
    expect(appleAssociationFile(config).status).toBe(404);
    expect(assetLinksFile(config).status).toBe(404);
  });

  it("carries the record's own URL and serves both files once configured", async () => {
    const config = parseEnv({
      ...base,
      COMPASS_APPLE_TEAM_IDS: "ABCDE12345",
      COMPASS_ANDROID_CERT_SHA256: Array(32).fill("AB").join(":"),
    });
    expect(handoffLink(record, config)).toEqual({
      url: "https://atlas.example.test/demo-productions/r/NWS-12",
      universal: true,
    });
    const apple = appleAssociationFile(config);
    expect(apple.status).toBe(200);
    expect(apple.headers.get("content-type")).toContain("application/json");
    expect(await apple.json()).toMatchObject({
      applinks: {
        details: [
          {
            appIDs: ["ABCDE12345.pro.ghxstship.compass"],
            components: [{ "/": "/*/r/*" }],
          },
        ],
      },
    });
    const android = assetLinksFile(config);
    expect(android.status).toBe(200);
    expect(await android.json()).toMatchObject([
      { target: { namespace: "android_app", package_name: "pro.ghxstship.compass" } },
    ]);
  });
});
