import { describe, expect, it } from "vitest";
import {
  appleAppSiteAssociation,
  assetLinks,
  compassPathForIncoming,
  compassRoute,
  compassSchemeUrl,
  handoffUrl,
  isRecordKey,
  parseHandoffUrl,
  shellFor,
  universalLinkConfig,
  universalLinksEnabled,
  webPath,
  type HandoffTarget,
} from "../src/handoff";

const record: HandoffTarget = { kind: "record", org: "demo-productions", recordKey: "NWS-12" };
const engagement: HandoffTarget = { kind: "engagement", engagementKey: "ENG-7" };
const FINGERPRINT = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, "0")).join(":");

describe("handoff links", () => {
  it("builds the web path, Compass route and scheme link of a record", () => {
    expect(webPath(record)).toBe("/demo-productions/r/NWS-12");
    expect(compassRoute(record)).toBe("/r/NWS-12?org=demo-productions");
    expect(compassSchemeUrl(record)).toBe("compass://r/NWS-12?org=demo-productions");
    expect(shellFor(record)).toBe("atlas");
  });

  it("builds the links of a Gateway engagement", () => {
    expect(webPath(engagement)).toBe("/work/engagements/ENG-7");
    expect(compassRoute(engagement)).toBe("/e/ENG-7");
    expect(compassSchemeUrl(engagement)).toBe("compass://e/ENG-7");
    expect(shellFor(engagement)).toBe("gateway");
  });

  it("carries the web URL once universal links are configured, the scheme link before", () => {
    expect(
      handoffUrl(record, { webOrigin: "https://atlas.example.com/", universalLinks: true }),
    ).toBe("https://atlas.example.com/demo-productions/r/NWS-12");
    expect(handoffUrl(record, { webOrigin: "http://127.0.0.1:3000", universalLinks: false })).toBe(
      "compass://r/NWS-12?org=demo-productions",
    );
  });

  it("reads every form back to the same item", () => {
    for (const link of [
      "compass://r/NWS-12?org=demo-productions",
      "compass:///r/NWS-12?org=demo-productions",
      "https://atlas.example.com/demo-productions/r/NWS-12",
      "/demo-productions/r/NWS-12",
      "/r/NWS-12?org=demo-productions",
    ]) {
      expect(parseHandoffUrl(link), link).toEqual(record);
    }
    for (const link of [
      "compass://e/ENG-7",
      "https://gateway.example.com/work/engagements/ENG-7",
      "https://gateway.example.com/work/engagements/ENG-7/shifts",
      "/e/ENG-7",
    ]) {
      expect(parseHandoffUrl(link), link).toEqual(engagement);
    }
  });

  it("refuses links that carry no valid item", () => {
    for (const link of [
      "",
      "   ",
      "compass://r/NWS-12",
      "compass://r/not-a-key?org=demo",
      "compass://schedule",
      "https://atlas.example.com/demo-productions/home",
      "https://atlas.example.com/Bad_Org/r/NWS-12",
      "mailto:someone@example.com",
      "https://atlas.example.com/demo/r/%E0%A4%A",
      "/work/engagements/%20bad",
    ]) {
      expect(parseHandoffUrl(link), link).toBeNull();
    }
  });

  it("round-trips through the scheme link and the universal link", () => {
    expect(parseHandoffUrl(compassSchemeUrl(record))).toEqual(record);
    expect(parseHandoffUrl(compassSchemeUrl(engagement))).toEqual(engagement);
    expect(
      parseHandoffUrl(handoffUrl(record, { webOrigin: "https://a.example", universalLinks: true })),
    ).toEqual(record);
  });

  it("rewrites incoming system paths to Compass routes and leaves others alone", () => {
    expect(compassPathForIncoming("https://atlas.example.com/demo-productions/r/NWS-12")).toBe(
      "/r/NWS-12?org=demo-productions",
    );
    expect(compassPathForIncoming("compass://e/ENG-7")).toBe("/e/ENG-7");
    expect(compassPathForIncoming("/schedule")).toBe("/schedule");
    expect(compassPathForIncoming("compass://incidents")).toBe("compass://incidents");
  });

  it("recognises record display keys", () => {
    expect(isRecordKey("NWS-1")).toBe(true);
    expect(isRecordKey("nws-1")).toBe(false);
    expect(isRecordKey("NWS-0")).toBe(false);
  });
});

describe("universal link files", () => {
  it("publishes nothing until the owner configures the apps", () => {
    const config = universalLinkConfig({});
    expect(universalLinksEnabled(config)).toBe(false);
    expect(appleAppSiteAssociation(config, "atlas")).toBeNull();
    expect(assetLinks(config)).toBeNull();
  });

  it("generates the apple-app-site-association for each shell's paths", () => {
    const config = universalLinkConfig({ COMPASS_APPLE_TEAM_IDS: "abcde12345, bad, ZYXWV98765" });
    expect(config.appleAppIds).toEqual([
      "ABCDE12345.pro.ghxstship.compass",
      "ZYXWV98765.pro.ghxstship.compass",
    ]);
    expect(universalLinksEnabled(config)).toBe(true);
    expect(appleAppSiteAssociation(config, "atlas")).toEqual({
      applinks: {
        details: [
          {
            appIDs: ["ABCDE12345.pro.ghxstship.compass", "ZYXWV98765.pro.ghxstship.compass"],
            components: [
              { "/": "/*/r/*", comment: "Continue on another device: atlas pages Compass opens" },
            ],
          },
        ],
      },
    });
    const gateway = appleAppSiteAssociation(config, "gateway") as {
      applinks: { details: { components: { "/": string }[] }[] };
    };
    expect(gateway.applinks.details[0]?.components.map((c) => c["/"])).toEqual([
      "/work/engagements/*",
    ]);
  });

  it("generates assetlinks.json from the signing certificate fingerprints", () => {
    const config = universalLinkConfig({ COMPASS_ANDROID_CERT_SHA256: `${FINGERPRINT},nope` });
    expect(universalLinksEnabled(config)).toBe(true);
    expect(assetLinks(config)).toEqual([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: "pro.ghxstship.compass",
          sha256_cert_fingerprints: [FINGERPRINT.toUpperCase()],
        },
      },
    ]);
  });
});
