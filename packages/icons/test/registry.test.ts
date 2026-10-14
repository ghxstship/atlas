import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  glyphIconNames,
  iconAliases,
  iconRegistry,
  isRegisteredIcon,
  lucideName,
  registeredIconNames,
  resolveIcon,
} from "../src/index.ts";
import { bundle, bundledIconNames } from "./bundle.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe("icon registry", () => {
  it("includes every canon glyph and every owner list entry", () => {
    for (const name of glyphIconNames) expect(registeredIconNames).toContain(name);
    const dir = fileURLToPath(new URL("../registry/", import.meta.url));
    for (const file of readdirSync(dir)) {
      const listed = readFileSync(`${dir}${file}`, "utf8")
        .split("\n")
        .map((line) => line.replace(/#.*/, "").trim())
        .filter(Boolean);
      for (const name of listed) expect(registeredIconNames, file).toContain(name);
    }
    expect(Object.keys(iconRegistry)).toEqual([...registeredIconNames]);
  });

  it("resolves PascalCase, kebab-case and the short aliases", () => {
    expect(resolveIcon("Hammer")).toBe(iconRegistry.Hammer);
    expect(resolveIcon("chevron-right")).toBe(iconRegistry.ChevronRight);
    for (const [alias, target] of Object.entries(iconAliases)) {
      expect(resolveIcon(alias)).toBe(iconRegistry[target]);
    }
    expect(lucideName("arrow-up-right")).toBe("ArrowUpRight");
    expect(isRegisteredIcon("search")).toBe(true);
  });

  it("refuses names outside the registry, including lucide internals", () => {
    expect(resolveIcon("Airplay")).toBeNull();
    expect(resolveIcon("icons")).toBeNull();
    expect(resolveIcon("createLucideIcon")).toBeNull();
    expect(resolveIcon("toString")).toBeNull();
    expect(isRegisteredIcon("NoSuchIcon")).toBe(false);
  });
});

describe("bundle size (RRR-70)", () => {
  it("bundles only the registered icons when drawing by name", async () => {
    const code = await bundle(fixture("registry-entry.ts"));
    const distinct = new Set(Object.values(iconRegistry)).size;
    expect(bundledIconNames(code).size).toBe(distinct);
    expect(bundledIconNames(code)).toContain("hammer");
    expect(bundledIconNames(code)).not.toContain("airplay");
  });

  it("would bundle the whole library through a namespace import", async () => {
    const code = await bundle(fixture("namespace-entry.ts"));
    expect(bundledIconNames(code).size).toBeGreaterThan(1500);
  });
});
