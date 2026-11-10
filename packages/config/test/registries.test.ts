import { describe, expect, it } from "vitest";
import {
  importTypeScript,
  loadCapabilityCodes,
  loadExpoRoutes,
  loadSitemapRoutes,
} from "../eslint/registries.mjs";

const apps = new URL("../../../apps/", import.meta.url);

// The registry lints read the generated registries the apps and the database read (S3.15-10).
describe("registries the lints read", () => {
  it("loads every capability code from the generated module", async () => {
    const codes = await loadCapabilityCodes();
    expect(codes).toContain("work.record.read");
    expect(codes.every((code) => /^[a-z][a-z_]*(?:\.[a-z][a-z_]*){2,3}$/.test(code))).toBe(true);
  });

  it("loads an app's sitemap routes and its shell routes", async () => {
    const atlas = await loadSitemapRoutes(new URL("atlas/", apps));
    expect(atlas).toContain("/{org}/home");
    expect(atlas).toContain("/auth/sign-in");
    expect(atlas).toContain("/api/v1/{...path}");
    const gateway = await loadSitemapRoutes(new URL("gateway/", apps));
    expect(gateway).toContain("/explore/{opportunityKey}");
  });

  it("reads Compass routes from its Expo Router tree", () => {
    const compass = loadExpoRoutes(new URL("compass/", apps));
    expect(compass).toContain("/");
    expect(compass).toContain("/today");
    expect(compass).toContain("/inspections/{templateId}");
    expect(compass.some((route) => route.includes("(") || route.includes("_layout"))).toBe(false);
  });

  it("refuses a module with a runtime import", async () => {
    await expect(
      importTypeScript(new URL("../eslint.config.mjs", import.meta.url)),
    ).rejects.toThrow(/runtime import/);
  });
});
