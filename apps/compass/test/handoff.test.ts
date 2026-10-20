import { readFileSync } from "node:fs";
import { compassPathForIncoming, HANDOFF_PATHS } from "@xos/ia/handoff";
import { describe, expect, it } from "vitest";
import type { ConfigContext, ExpoConfig } from "expo/config";
import appConfig, {
  LINK_PATHS,
  PRODUCTION_LINK_HOSTS,
  universalLinkHosts,
  withUniversalLinks,
} from "../app.config";
import {
  nativeScreenFor,
  NATIVE_RECORD_SCREENS,
  recordTargetFromParams,
  webFallbackUrl,
} from "../src/domain/handoff";

/** Continue on another device in Compass (journey 58, ADR 0030). */
const config = { atlasUrl: "http://localhost:3145/", gatewayUrl: "http://localhost:3146" };

describe("handoff routes", () => {
  it("opens every handoff link form on the Compass record route", () => {
    expect(compassPathForIncoming("compass://r/NWS-12?org=demo-productions")).toBe(
      "/r/NWS-12?org=demo-productions",
    );
    expect(compassPathForIncoming("https://atlas.example.com/demo-productions/r/NWS-12")).toBe(
      "/r/NWS-12?org=demo-productions",
    );
    expect(compassPathForIncoming("https://gateway.example.com/work/engagements/E-AB12")).toBe(
      "/e/E-AB12",
    );
    expect(compassPathForIncoming("compass://schedule")).toBe("compass://schedule");
  });

  it("has a route file for each handoff route", () => {
    for (const file of ["../app/r/[recordKey].tsx", "../app/e/[engagementKey].tsx"]) {
      expect(readFileSync(new URL(file, import.meta.url), "utf8")).toContain("export default");
    }
    expect(readFileSync(new URL("../app/+native-intent.tsx", import.meta.url), "utf8")).toContain(
      "compassPathForIncoming",
    );
  });

  it("opens kinds with a Compass screen natively and the rest on the web", () => {
    expect(nativeScreenFor("Inspection")?.route).toBe("/inspections");
    expect(nativeScreenFor("Shift")?.route).toBe("/schedule");
    expect(nativeScreenFor("Training")?.route).toBe("/workforce/training");
    expect(nativeScreenFor("Contract")).toBeNull();
    const files: Record<string, string> = {
      "/schedule": "(tabs)/schedule.tsx",
      "/inspections": "inspections/index.tsx",
      "/workforce/training": "workforce/training.tsx",
    };
    for (const screen of Object.values(NATIVE_RECORD_SCREENS)) {
      const file = files[screen.route];
      expect(file, screen.route).toBeDefined();
      expect(readFileSync(new URL(`../app/${file}`, import.meta.url), "utf8")).toContain(
        "export default",
      );
    }
  });

  it("falls back to the page on Atlas or Gateway", () => {
    expect(
      webFallbackUrl({ kind: "record", org: "demo-productions", recordKey: "NWS-12" }, config),
    ).toBe("http://localhost:3145/demo-productions/r/NWS-12");
    expect(webFallbackUrl({ kind: "engagement", engagementKey: "E-AB12" }, config)).toBe(
      "http://localhost:3146/work/engagements/E-AB12",
    );
  });

  it("reads the record from the route params, with the person's own org as the fallback", () => {
    expect(recordTargetFromParams({ recordKey: "NWS-12", org: "demo-productions" }, null)).toEqual({
      kind: "record",
      org: "demo-productions",
      recordKey: "NWS-12",
    });
    expect(recordTargetFromParams({ recordKey: ["NWS-12"] }, "acme")).toEqual({
      kind: "record",
      org: "acme",
      recordKey: "NWS-12",
    });
    expect(recordTargetFromParams({ recordKey: "NWS-12", org: ["x"] }, null)?.kind).toBe("record");
    expect(recordTargetFromParams({ recordKey: "NWS-12" }, null)).toBeNull();
    expect(recordTargetFromParams({}, "acme")).toBeNull();
  });
});

describe("universal links in the app config", () => {
  const base = { name: "Compass", slug: "xos-compass", ios: {}, android: {} } as ExpoConfig;

  it("restates the shells' paths exactly", () => {
    expect(LINK_PATHS).toEqual(HANDOFF_PATHS);
  });

  it("adds nothing for an empty host list", () => {
    expect(universalLinkHosts(undefined)).toEqual([]);
    expect(universalLinkHosts("")).toEqual([]);
    expect(withUniversalLinks(base, [])).toBe(base);
  });

  it("claims the production hosts by default, and none when the variable is empty", () => {
    const previous = process.env["XOS_UNIVERSAL_LINK_HOSTS"];
    try {
      delete process.env["XOS_UNIVERSAL_LINK_HOSTS"];
      const out = appConfig({ config: base } as ConfigContext);
      expect(out.ios?.associatedDomains).toEqual([
        "applinks:atlas.ghxstship.tech",
        "applinks:gateway.ghxstship.tech",
      ]);
      expect(out.android?.intentFilters?.map((f) => f.data)).toEqual([
        [{ scheme: "https", host: "atlas.ghxstship.tech", pathPattern: "/.*/r/.*" }],
        [{ scheme: "https", host: "gateway.ghxstship.tech", pathPattern: "/work/engagements/.*" }],
      ]);
      expect(universalLinkHosts(PRODUCTION_LINK_HOSTS)).toHaveLength(2);
      process.env["XOS_UNIVERSAL_LINK_HOSTS"] = "";
      expect(appConfig({ config: base } as ConfigContext)).toBe(base);
    } finally {
      if (previous === undefined) delete process.env["XOS_UNIVERSAL_LINK_HOSTS"];
      else process.env["XOS_UNIVERSAL_LINK_HOSTS"] = previous;
    }
  });

  it("adds associated domains and verified App Links for each named host", () => {
    const hosts = universalLinkHosts(
      "atlas:atlas.example.com, gateway:Gateway.Example.com, bogus:x.example.com, atlas:not a host",
    );
    expect(hosts).toEqual([
      { shell: "atlas", host: "atlas.example.com" },
      { shell: "gateway", host: "gateway.example.com" },
    ]);
    const out = withUniversalLinks(base, hosts);
    expect(out.ios?.associatedDomains).toEqual([
      "applinks:atlas.example.com",
      "applinks:gateway.example.com",
    ]);
    expect(out.android?.intentFilters).toEqual([
      {
        action: "VIEW",
        autoVerify: true,
        category: ["BROWSABLE", "DEFAULT"],
        data: [{ scheme: "https", host: "atlas.example.com", pathPattern: "/.*/r/.*" }],
      },
      {
        action: "VIEW",
        autoVerify: true,
        category: ["BROWSABLE", "DEFAULT"],
        data: [
          { scheme: "https", host: "gateway.example.com", pathPattern: "/work/engagements/.*" },
        ],
      },
    ]);
  });

  it("registers the notifications plugin for actionable pushes", () => {
    const app = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8")) as {
      expo: { plugins: unknown[]; scheme: string };
    };
    expect(app.expo.plugins).toContain("expo-notifications");
    expect(app.expo.scheme).toBe("compass");
  });
});
