import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { flattenRoutes, matchRoute, routesOverlap } from "@xos/ia";
import { loadSitemapFile } from "@xos/ia/node";
import { pageFile } from "../ia/generate";
import { appRoot, renderGeneratedFiles, routeFiles, stampedFiles } from "../ia/generate-node";
import { DELEGATED, IMPLEMENTED, SHELL_ROUTES } from "../ia/routes.config";

/**
 * The route generator and gate 15. `pnpm --filter @xos/atlas generate:routes` runs this file with
 * XOS_WRITE_GENERATED=1 to write the files; every other run fails on drift instead.
 */
const write = process.env["XOS_WRITE_GENERATED"] === "1";
const sitemap = loadSitemapFile(join(appRoot, "ia/sitemap.yaml"));
let files: Map<string, string>;

beforeAll(async () => {
  files = await renderGeneratedFiles();
  if (!write) return;
  for (const [path, source] of files) {
    const target = join(appRoot, path);
    if (existsSync(target) && readFileSync(target, "utf8") === source) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  for (const path of stampedFiles()) if (!files.has(path)) rmSync(join(appRoot, path));
});

describe("generated route tree", () => {
  it("matches ia/sitemap.yaml with no hand edits", () => {
    const changed = [...files]
      .filter(([path, source]) => {
        const target = join(appRoot, path);
        return !existsSync(target) || readFileSync(target, "utf8") !== source;
      })
      .map(([path]) => path);
    expect(changed).toEqual([]);
  });

  it("leaves no stale generated file behind", () => {
    expect(stampedFiles().filter((path) => !files.has(path))).toEqual([]);
  });

  it("has a hand-written page for every implemented node", () => {
    const routes = new Map(flattenRoutes(sitemap).map((r) => [r.id, r.route]));
    for (const id of IMPLEMENTED) {
      const route = routes.get(id);
      expect(route, id).toBeDefined();
      const path = pageFile(route as string);
      expect(existsSync(join(appRoot, path)), path).toBe(true);
      expect(files.has(path), path).toBe(false);
    }
  });
});

describe("gate 15: sitemap and routes", () => {
  const routed = flattenRoutes(sitemap);

  it("gives every sitemap node a route file, unless another shell or agent serves it", () => {
    const missing = routed
      .filter((r) => r.servedBy === undefined && !(r.id in DELEGATED))
      .filter((r) => !existsSync(join(appRoot, pageFile(r.route))))
      .map((r) => r.id);
    expect(missing).toEqual([]);
    for (const r of routed.filter((n) => n.servedBy !== undefined)) {
      expect(DELEGATED[r.id], r.id).toBeDefined();
    }
  });

  it("maps every route file to a sitemap node or a declared shell route", () => {
    const patterns = [...routed.map((r) => r.route), ...Object.keys(SHELL_ROUTES)];
    const orphans = routeFiles().filter((file) => {
      const pattern =
        `/${file
          .replace(/^app\//, "")
          .replace(/\/?(page|route)\.tsx?$/, "")
          .replace(/\[([^\]]+)\]/g, "{$1}")}`.replace(/\/$/, "") || "/";
      return !patterns.includes(pattern === "" ? "/" : pattern);
    });
    expect(orphans).toEqual([]);
  });

  it("keeps shell routes clear of every sitemap route", () => {
    for (const shellRoute of Object.keys(SHELL_ROUTES)) {
      for (const r of routed) {
        expect(routesOverlap(shellRoute, r.route, sitemap.params), `${shellRoute} ${r.route}`).toBe(
          false,
        );
      }
    }
    expect(matchRoute("/{org}/home", "/auth/home", sitemap.params)).toBeNull();
  });
});
