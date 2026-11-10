import { readdirSync, readFileSync } from "node:fs";
import Module from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { refuseTestOnlySwitches, TEST_ONLY_SWITCHES } from "../app.config";

const root = new URL("..", import.meta.url).pathname;
const read = (path: string) => readFileSync(join(root, path), "utf8");

/** Loads metro.config.js as Metro does, as CommonJS, with the gallery switch set or not. */
function metroBlockList(gallery: string | undefined): RegExp[] {
  if (gallery === undefined) delete process.env["EXPO_PUBLIC_XOS_GALLERY"];
  else process.env["EXPO_PUBLIC_XOS_GALLERY"] = gallery;
  const file = join(root, "metro.config.js");
  type Loader = Module & {
    _compile(source: string, filename: string): void;
    exports: { resolver: { blockList?: RegExp | RegExp[] } };
  };
  const loader = new Module(file) as Loader;
  loader.filename = file;
  loader.paths = (
    Module as unknown as { _nodeModulePaths(dir: string): string[] }
  )._nodeModulePaths(root);
  loader._compile(readFileSync(file, "utf8"), file);
  return [loader.exports.resolver.blockList ?? []].flat();
}

const saved = process.env["EXPO_PUBLIC_XOS_GALLERY"];
afterEach(() => {
  if (saved === undefined) delete process.env["EXPO_PUBLIC_XOS_GALLERY"];
  else process.env["EXPO_PUBLIC_XOS_GALLERY"] = saved;
});

function sources(dir: string): string[] {
  return (readdirSync(join(root, dir), { recursive: true }) as string[])
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => join(dir, f));
}

describe("component gallery (A141)", () => {
  const route = join(root, "app/dev/gallery.tsx");

  it("is left out of every build but a gallery build", () => {
    const blocked = (list: RegExp[], path: string) => list.some((r) => r.test(path));
    for (const off of [undefined, "", "0"]) {
      const list = metroBlockList(off);
      expect(blocked(list, route), String(off)).toBe(true);
      expect(blocked(list, join(root, "app/dev")), String(off)).toBe(true);
      // Only that folder: neighbours that merely start with "dev" stay in.
      expect(blocked(list, join(root, "app/devices.tsx"))).toBe(false);
      expect(blocked(list, join(root, "app/_layout.tsx"))).toBe(false);
    }
    expect(blocked(metroBlockList("1"), route)).toBe(false);
  });

  it("refuses the gallery switch in EAS builds", () => {
    expect(TEST_ONLY_SWITCHES).toContain("EXPO_PUBLIC_XOS_GALLERY");
    expect(() =>
      refuseTestOnlySwitches({ EXPO_PUBLIC_XOS_GALLERY: "1", EAS_BUILD: "true" }),
    ).toThrow(/EXPO_PUBLIC_XOS_GALLERY/);
    expect(() => refuseTestOnlySwitches({ EXPO_PUBLIC_XOS_GALLERY: "1" })).not.toThrow();
  });

  it("is in neither the sitemap nor the navigation", () => {
    // "gallery" alone is a collection view there; the route is app/dev/gallery.
    for (const file of ["ia/sitemap.yaml", "src/navigation.generated.ts"]) {
      expect(read(file), file).not.toMatch(/\bdev\/|\/dev\b|\bid: dev\b|"dev"/);
    }
  });

  it("is opened only by its link: no screen links to it, and only its route imports it", () => {
    const others = [...sources("app"), ...sources("src")].filter(
      (f) => !f.startsWith("app/dev/") && f !== "app/_layout.tsx",
    );
    expect(others.length).toBeGreaterThan(50);
    for (const file of others) {
      const text = read(file);
      expect(text, file).not.toContain("dev/gallery");
      expect(text, file).not.toContain("@xos/ui-native/gallery");
    }
    expect(read("app/dev/gallery.tsx")).toContain('from "@xos/ui-native/gallery"');
  });

  it("skips sign-in and sync for the gallery only in a gallery build", () => {
    expect(read("app/_layout.tsx")).toContain(
      'process.env["EXPO_PUBLIC_XOS_GALLERY"] === "1" && pathname.startsWith("/dev/")',
    );
  });
});
