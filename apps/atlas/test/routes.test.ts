import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  findRoute,
  flattenRoutes,
  getNode,
  matchRoute,
  resolveBreadcrumbs,
  routesOverlap,
} from "@xos/ia";
import { loadSitemapFile } from "@xos/ia/node";
import { packNodes, unpackNodes } from "../ia/client-sitemap-codec";
import { clientSitemap, listNodeIds, pageFile } from "../ia/generate";
import { appRoot, renderGeneratedFiles, routeFiles, stampedFiles } from "../ia/generate-node";
import { IMPLEMENTED } from "../ia/implemented";
import { DELEGATED, ROUTE_HANDLER_FILES, SHELL_ROUTES } from "../ia/routes.config";

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
      .filter((r) => !existsSync(join(appRoot, ROUTE_HANDLER_FILES[r.id] ?? pageFile(r.route))))
      .map((r) => r.id);
    expect(missing).toEqual([]);
    for (const id of Object.keys(ROUTE_HANDLER_FILES)) {
      expect(
        routed.some((r) => r.id === id && r.servedBy === undefined),
        id,
      ).toBe(true);
      expect(id in DELEGATED, id).toBe(false);
    }
    for (const r of routed.filter((n) => n.servedBy !== undefined)) {
      expect(DELEGATED[r.id], r.id).toBeDefined();
    }
  });

  it("maps every route file to a sitemap node or a declared shell route", () => {
    const patterns = [...routed.map((r) => r.route), ...Object.keys(SHELL_ROUTES)];
    const handlerFiles = new Set(Object.values(ROUTE_HANDLER_FILES));
    const orphans = routeFiles().filter((file) => {
      if (handlerFiles.has(file)) return false;
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

describe("client sitemap", () => {
  const samples: Record<string, string> = {
    slug: "demo-productions",
    "project-key": "NWS",
    "record-key": "NWS-12",
    "display-key": "NWS-A1",
    handle: "maria",
    uuid: "4f5c3a2e-1b2c-4d3e-8f9a-0b1c2d3e4f5a",
    token: "abcdefghijklmnop1234",
  };
  const client = clientSitemap(sitemap);

  it("matches and crumbs every route as the full sitemap does", () => {
    for (const r of flattenRoutes(sitemap)) {
      const path = r.route.replace(/\{(\w+)\}/g, (_, name: string) => {
        const type = sitemap.params[name]?.type ?? "slug";
        return samples[type] ?? "x";
      });
      expect(findRoute(client, path), path).toEqual(findRoute(sitemap, path));
      expect(resolveBreadcrumbs(client, path, { workspace: "Tour" }), path).toEqual(
        resolveBreadcrumbs(sitemap, path, { workspace: "Tour" }),
      );
    }
  });

  it("lists exactly the routed nodes with a list", () => {
    const withList = flattenRoutes(sitemap)
      .filter((r) => getNode(sitemap, r.id).node.list !== undefined)
      .map((r) => r.id);
    expect(listNodeIds(sitemap)).toEqual(withList);
  });

  it("ships nodes packed that unpack to exactly the client sitemap", () => {
    const packed = packNodes(client.nodes);
    expect(unpackNodes(JSON.parse(JSON.stringify(packed)) as typeof packed)).toEqual(client.nodes);
  });

  it("carries no visibility, list or persona data", () => {
    const text = JSON.stringify(client);
    for (const field of ['"visibility"', '"list"', '"personas"', '"chrome"', '"tags"']) {
      expect(text).not.toContain(field);
    }
  });
});
