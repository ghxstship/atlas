import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Section 4.10 (S4.10-07): the latest two versions of Chrome, Edge, Firefox, Safari and Safari on
 * iOS and iPadOS. The target is the root package.json's browserslist, which each Next.js build
 * finds by walking up from its app, so SWC and Lightning CSS compile for those browsers only.
 */
const root = new URL("../../../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
  browserslist?: string[];
};

describe("the browser target", () => {
  it("is pinned to the latest two major versions of each supported browser", () => {
    expect(pkg.browserslist).toEqual([
      "last 2 Chrome major versions",
      "last 2 Edge major versions",
      "last 2 Firefox major versions",
      "last 2 Safari major versions",
      "last 2 iOS major versions",
    ]);
  });

  for (const app of ["atlas", "gateway", "docs", "console"]) {
    it(`is the one ${app}'s Next.js build reads`, () => {
      const appDir = new URL(`apps/${app}/`, root);
      const require = createRequire(new URL("package.json", appDir));
      const browserslist = require("next/dist/compiled/browserslist") as {
        (query: readonly string[]): string[];
        loadConfig(opts: { path: string; env: string }): string[] | undefined;
      };
      const config = browserslist.loadConfig({ path: appDir.pathname, env: "production" });
      expect(config).toEqual(pkg.browserslist);
      const browsers = browserslist(config ?? []);
      for (const name of ["chrome", "edge", "firefox", "safari", "ios_saf"]) {
        const majors = new Set(
          browsers.filter((b) => b.startsWith(`${name} `)).map((b) => b.split(/[ .]/)[1]),
        );
        expect(majors.size, name).toBe(2);
      }
    });
  }
});
