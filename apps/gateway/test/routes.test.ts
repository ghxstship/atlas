import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { flattenRoutes, routesOverlap } from "@xos/ia";
import { loadSitemapFile } from "@xos/ia/node";
import { format, resolveConfig } from "prettier";
import { routeSegments, sitemapSource } from "../ia/generate";
import { SHELL_ROUTES } from "../ia/routes.config";

/**
 * The generated sitemap module and gate 23: every node in ia/sitemap.yaml renders, and every
 * Gateway route belongs to a node or a declared shell route. `pnpm --filter @xos/gateway
 * generate:sitemap` runs this file with XOS_WRITE_GENERATED=1 to write the module.
 */
const appRoot = fileURLToPath(new URL("../", import.meta.url));
const sitemap = loadSitemapFile(join(appRoot, "ia/sitemap.yaml"));
const target = join(appRoot, "ia/sitemap.generated.ts");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

/** Route files as sitemap patterns; route groups such as `(shell)` add no segment. */
function routePatterns(): { file: string; pattern: string }[] {
  return walk(join(appRoot, "app"))
    .filter((path) => /\/(page|route)\.tsx?$/.test(path))
    .map((path) => {
      const file = relative(appRoot, path);
      const segments = file
        .replace(/^app\//, "")
        .replace(/\/?(page|route)\.tsx?$/, "")
        .split("/")
        .filter((s) => s !== "" && !/^\(.*\)$/.test(s))
        .map((s) => s.replace(/^\[([^\]]+)\]$/, "{$1}"));
      return { file, pattern: `/${segments.join("/")}` };
    });
}

describe("generated sitemap module", () => {
  it("matches ia/sitemap.yaml with no hand edits", async () => {
    const options = (await resolveConfig(target)) ?? {};
    const source = await format(sitemapSource(sitemap), { ...options, filepath: target });
    if (process.env["XOS_WRITE_GENERATED"] === "1") writeFileSync(target, source);
    expect(existsSync(target) && readFileSync(target, "utf8") === source).toBe(true);
  });
});

describe("gate 23: Gateway sitemap and routes", () => {
  const routed = flattenRoutes(sitemap);
  const patterns = routePatterns();

  it("gives every sitemap node a route file", () => {
    const served = new Set(patterns.map((p) => p.pattern));
    const missing = routed.filter((r) => !served.has(r.route)).map((r) => `${r.id} ${r.route}`);
    expect(missing).toEqual([]);
  });

  it("maps every route file to a sitemap node or a declared shell route", () => {
    const known = new Set([...routed.map((r) => r.route), ...Object.keys(SHELL_ROUTES)]);
    expect(patterns.filter((p) => !known.has(p.pattern)).map((p) => p.file)).toEqual([]);
  });

  it("keeps shell routes clear of every sitemap route", () => {
    for (const shellRoute of Object.keys(SHELL_ROUTES)) {
      for (const r of routed) {
        expect(routesOverlap(shellRoute, r.route, sitemap.params), `${shellRoute} ${r.route}`).toBe(
          false,
        );
      }
    }
  });

  it("writes route segments for params", () => {
    expect(routeSegments("/u/{handle}")).toEqual(["u", "[handle]"]);
  });
});
