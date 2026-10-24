/**
 * Enterprise branded Compass builds and EAS Update (Section 12 Mobile, Section 13 Distribution; A65-011
 * part 3): the per-tenant profile generator, the tenant build definition app.config.ts applies, the release
 * guard extended to tenant profiles, and the update channels.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExpoConfig } from "expo/config";
import { describe, expect, it } from "vitest";
import appConfig, {
  appGroupFor,
  isReleaseProfile,
  readTenant,
  releaseConfigProblems,
  tenantProblems,
  tenantReleaseProblems,
  withTenant,
  withUpdates,
} from "../app.config";
import { preflightProblems } from "../scripts/store-preflight";
import {
  checkTenants,
  parseArgs,
  tenantDefinition,
  tenantStoreConfig,
  withTenantProfiles,
} from "../scripts/tenant-profile";

const compassDir = fileURLToPath(new URL("..", import.meta.url));
const readJson = (path: string) =>
  JSON.parse(readFileSync(join(compassDir, path), "utf8")) as Record<string, unknown>;
const expo = (readJson("app.json") as { expo: ExpoConfig }).expo;
const easJson = readJson("eas.json");

const ACME = [
  "--slug",
  "acme",
  "--org",
  "acme-live",
  "--name",
  "Acme Crew",
  "--bundle-id",
  "com.acme.crew",
  "--accent",
  "#b45309",
  "--hosts",
  "atlas:atlas.acme.example,gateway:crew.acme.example",
];

function acme() {
  const args = parseArgs(ACME);
  if ("error" in args) throw new Error(args.error);
  return tenantDefinition(args);
}

describe("the per-tenant profile generator", () => {
  it("derives a complete, valid definition from the flags", () => {
    const tenant = acme();
    expect(tenant).toEqual({
      slug: "acme",
      orgSlug: "acme-live",
      name: "Acme Crew",
      bundleIdentifier: "com.acme.crew",
      androidPackage: "com.acme.crew",
      scheme: "acme",
      accent: "#B45309",
      icon: "./tenants/acme/icon.png",
      splash: "./tenants/acme/splash.png",
      storeConfig: "./tenants/acme/store.config.json",
      easProjectId: "OWNER_EAS_PROJECT_ID",
      universalLinkHosts: "atlas:atlas.acme.example,gateway:crew.acme.example",
    });
    expect(tenantProblems(tenant)).toEqual([]);
    expect(parseArgs(["--slug"])).toEqual({ error: "Unknown or incomplete flag: --slug" });
    expect(parseArgs(["--slug", "acme"])).toEqual({ error: "Missing --org" });
    expect(parseArgs(["--colour", "red"])).toMatchObject({
      error: expect.stringContaining("--colour"),
    });
  });

  it("refuses a definition that cannot build", () => {
    const bad = {
      ...acme(),
      slug: "Acme!",
      bundleIdentifier: "pro.ghxstship.compass",
      accent: "orange",
      icon: "/etc/icon.png",
      easProjectId: "my-project",
      universalLinkHosts: "atlas:not a host",
    };
    const problems = tenantProblems(bad).join("\n");
    for (const field of ["slug", "accent", "icon", "easProjectId", "universalLinkHosts"])
      expect(problems).toContain(field);
    expect(problems).toContain("must differ from the platform build's");
    expect(tenantProblems(null)).toEqual(["the tenant definition is not an object"]);
  });

  it("adds tenant build and submit profiles that extend production on their own channel", () => {
    const out = withTenantProfiles(easJson, acme()) as {
      build: Record<string, Record<string, unknown>>;
      submit: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(out.build["tenant-acme"]).toEqual({
      extends: "production",
      channel: "tenant-acme",
      env: { XOS_TENANT: "acme" },
    });
    expect(out.build["production"]).toEqual(
      (easJson["build"] as Record<string, unknown>)["production"],
    );
    expect(out.submit["tenant-acme"]?.["ios"]).toMatchObject({
      ascAppId: "OWNER_ASC_APP_ID",
      appleTeamId: "OWNER_APPLE_TEAM_ID",
      metadataPath: "./tenants/acme/store.config.json",
    });
    expect(out.submit["tenant-acme"]?.["android"]?.["track"]).toBe("internal");
    // The store preflight refuses the tenant's submission until the tenant's values are filled.
    expect(
      preflightProblems(
        "ios",
        { easJson: out, storeConfig: {}, appVersion: "4.0.0", fileExists: () => false, icon: null },
        "tenant-acme",
      ).join("\n"),
    ).toContain("eas.json submit.tenant-acme.ios.ascAppId: OWNER_ASC_APP_ID");
  });

  it("names the tenant's app in every listing locale and keeps the rest", () => {
    const store = readJson("store/store.config.json");
    const out = tenantStoreConfig(store, acme()) as {
      apple: { info: Record<string, { title: string; description: string }>; version: string };
    };
    for (const entry of Object.values(out.apple.info)) expect(entry.title).toBe("Acme Crew");
    expect(out.apple.version).toBe((store["apple"] as { version: string }).version);
    expect(Object.keys(out.apple.info).length).toBeGreaterThan(0);
  });

  it("checks committed tenants against eas.json", () => {
    const tenant = acme();
    const withProfiles = withTenantProfiles(easJson, tenant);
    expect(checkTenants(withProfiles, [{ file: "acme.json", value: tenant }])).toEqual([]);
    expect(checkTenants(easJson, [{ file: "acme.json", value: tenant }])).toEqual([
      "eas.json has no build profile tenant-acme for acme.json",
    ]);
    expect(checkTenants(withProfiles, [])).toEqual([
      "eas.json build profile tenant-acme has no tenant definition",
    ]);
    expect(checkTenants(withProfiles, [{ file: "other.json", value: tenant }])).toContain(
      "other.json: slug acme differs from the file name",
    );
    // The repository's own eas.json and tenants/ agree (no tenant is committed yet).
    expect(checkTenants(easJson, [])).toEqual([]);
  });
});

describe("a tenant's build (app.config.ts)", () => {
  it("applies the tenant's name, identifiers, icon, splash, App Group and update project", () => {
    const tenant = { ...acme(), easProjectId: "11111111-2222-4333-8444-555555555555" };
    const out = withUpdates(withTenant(expo, tenant), { EAS_BUILD: "true" });
    expect(out).toMatchObject({
      name: "Acme Crew",
      slug: "xos-compass-acme",
      scheme: "acme",
      icon: "./tenants/acme/icon.png",
      ios: { bundleIdentifier: "com.acme.crew" },
      android: { package: "com.acme.crew", adaptiveIcon: { backgroundColor: "#B45309" } },
      extra: {
        eas: { projectId: "11111111-2222-4333-8444-555555555555" },
        tenant: { slug: "acme", orgSlug: "acme-live", name: "Acme Crew", accent: "#B45309" },
      },
      updates: {
        url: "https://u.expo.dev/11111111-2222-4333-8444-555555555555",
        enabled: true,
      },
      runtimeVersion: { policy: "fingerprint" },
    });
    expect(out.plugins).toContainEqual([
      "expo-splash-screen",
      expect.objectContaining({ image: "./tenants/acme/splash.png", backgroundColor: "#B45309" }),
    ]);
    // The widget extension shares the tenant's own App Group, never the platform build's.
    expect(out.ios?.entitlements?.["com.apple.security.application-groups"]).toEqual([
      "group.com.acme.crew",
    ]);
    expect(appGroupFor("pro.ghxstship.compass")).toBe(
      (expo.ios?.entitlements?.["com.apple.security.application-groups"] as string[])[0],
    );
    // Until the tenant's EAS project exists the build carries none, and a release build stops.
    expect(withTenant(expo, acme()).extra?.["eas"]).toEqual({ projectId: undefined });
  });

  it("stops a tenant release build that still waits on the tenant's accounts or art", () => {
    const env = { EAS_BUILD: "true", EAS_BUILD_PROFILE: "tenant-acme" };
    expect(tenantReleaseProblems(acme(), env, () => false)).toEqual([
      "tenants/acme.json easProjectId is still OWNER_EAS_PROJECT_ID",
      "the tenant file ./tenants/acme/icon.png is missing",
      "the tenant file ./tenants/acme/splash.png is missing",
      "the tenant file ./tenants/acme/store.config.json is missing",
    ]);
    const ready = { ...acme(), easProjectId: "11111111-2222-4333-8444-555555555555" };
    expect(tenantReleaseProblems(ready, env, () => true)).toEqual([]);
    expect(
      tenantReleaseProblems(acme(), { EAS_BUILD_PROFILE: "tenant-acme" }, () => false),
    ).toEqual([]);
    // A tenant profile is a release profile: the server URLs are checked as for production.
    expect(isReleaseProfile("tenant-acme")).toBe(true);
    expect(isReleaseProfile("development")).toBe(false);
    expect(releaseConfigProblems(env)).toHaveLength(4);
  });

  it("reads tenants/<slug>.json for XOS_TENANT and refuses an unknown or invalid one", () => {
    const root = mkdtempSync(join(tmpdir(), "a93-tenant-"));
    mkdirSync(join(root, "tenants"));
    writeFileSync(join(root, "tenants", "acme.json"), JSON.stringify(acme()));
    writeFileSync(join(root, "tenants", "broken.json"), JSON.stringify({ ...acme(), slug: "x!" }));
    expect(readTenant(root, "acme").bundleIdentifier).toBe("com.acme.crew");
    expect(() => readTenant(root, "missing")).toThrow(/run scripts\/tenant-profile\.ts/);
    expect(() => readTenant(root, "broken")).toThrow(/is not valid/);
    expect(() => readTenant(root, "../etc")).toThrow(/not a tenant slug/);
    const previous = process.env["XOS_TENANT"];
    process.env["XOS_TENANT"] = "acme";
    try {
      const out = appConfig({ config: expo, projectRoot: root } as Parameters<typeof appConfig>[0]);
      expect(out.ios?.bundleIdentifier).toBe("com.acme.crew");
      // The tenant's custom domains replace the platform's universal link hosts.
      expect(out.ios?.associatedDomains).toEqual([
        "applinks:atlas.acme.example",
        "applinks:crew.acme.example",
      ]);
    } finally {
      if (previous === undefined) delete process.env["XOS_TENANT"];
      else process.env["XOS_TENANT"] = previous;
    }
  });
});

describe("EAS Update", () => {
  it("serves updates from the project's channel in EAS builds only, by native fingerprint", () => {
    const eas = withUpdates(expo, { EAS_BUILD: "true" });
    const projectId = (expo.extra?.["eas"] as { projectId: string }).projectId;
    expect(eas.updates).toMatchObject({
      url: `https://u.expo.dev/${projectId}`,
      enabled: true,
      checkAutomatically: "ON_LOAD",
    });
    expect(eas.runtimeVersion).toEqual({ policy: "fingerprint" });
    // Local and Maestro builds run their embedded bundle unless asked.
    expect(withUpdates(expo, {}).updates?.enabled).toBe(false);
    expect(withUpdates(expo, { XOS_UPDATES: "1" }).updates?.enabled).toBe(true);
    expect(withUpdates({ ...expo, extra: {} }, {})).toEqual({ ...expo, extra: {} });
  });
});
