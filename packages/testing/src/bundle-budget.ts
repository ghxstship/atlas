import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { gzipSync } from "node:zlib";
import { webBudgets } from "./budgets.ts";
import { lighthouseTargets, type LighthouseApp } from "./lighthouse.ts";

/**
 * Route JavaScript from a production build, without a browser (Section 18, gate 10). For one page
 * it adds the root main files to every chunk the page's client reference manifest lists for its
 * segments (layouts, page, error and not-found boundaries), then gzips each chunk once. That is
 * what the browser downloads on a cold load of the route, as Lighthouse's
 * `resource-summary:script:size` counts it, without the lazy chunks a click fetches later.
 */

export interface RouteBundle {
  readonly path: string;
  readonly route: string;
  readonly files: readonly string[];
  readonly gzipBytes: number;
}

/** Matches a URL path to an app route such as `/[org]/home/page`; static segments win. */
export function matchRoute(routes: readonly string[], path: string): string | null {
  const parts = path.split("/").filter(Boolean);
  let best: { route: string; score: number } | null = null;
  for (const route of routes) {
    if (!route.endsWith("/page")) continue;
    const segments = route
      .slice(0, -"/page".length)
      .split("/")
      .filter((s) => s !== "" && !/^\(.*\)$/.test(s));
    if (segments.length !== parts.length) continue;
    let score = 0;
    let ok = true;
    segments.forEach((segment, i) => {
      if (segment === parts[i]) score += 2;
      else if (/^\[[^.]+\]$/.test(segment)) score += 1;
      else ok = false;
    });
    if (ok && (best === null || score > best.score)) best = { route, score };
  }
  return best?.route ?? null;
}

interface ClientManifest {
  readonly entryJSFiles?: Record<string, readonly string[]>;
}

function readClientManifest(nextDir: string, route: string): ClientManifest {
  const file = join(nextDir, "server/app", `${route}_client-reference-manifest.js`);
  const sandbox: { globalThis: { __RSC_MANIFEST?: Record<string, ClientManifest> } } = {
    globalThis: {},
  };
  runInNewContext(readFileSync(file, "utf8"), sandbox);
  const manifests = sandbox.globalThis.__RSC_MANIFEST ?? {};
  const manifest = manifests[route] ?? Object.values(manifests)[0];
  if (manifest === undefined) throw new Error(`No client reference manifest for ${route}.`);
  return manifest;
}

const gzipCache = new Map<string, number>();

function gzipBytes(file: string): number {
  let size = gzipCache.get(file);
  if (size === undefined) {
    size = gzipSync(readFileSync(file), { level: 9 }).length;
    gzipCache.set(file, size);
  }
  return size;
}

/** The chunks one route loads on a cold visit and their total gzip size. */
export function routeBundle(nextDir: string, path: string): RouteBundle {
  const routes = Object.keys(
    JSON.parse(readFileSync(join(nextDir, "server/app-paths-manifest.json"), "utf8")) as Record<
      string,
      string
    >,
  );
  const route = matchRoute(routes, path);
  if (route === null) throw new Error(`No route in ${nextDir} serves ${path}.`);
  const build = JSON.parse(readFileSync(join(nextDir, "build-manifest.json"), "utf8")) as {
    rootMainFiles?: readonly string[];
  };
  const files = new Set<string>(build.rootMainFiles ?? []);
  for (const chunks of Object.values(readClientManifest(nextDir, route).entryJSFiles ?? {})) {
    for (const chunk of chunks) files.add(chunk.replace(/^\/_next\//, ""));
  }
  const sorted = [...files].filter((f) => f.endsWith(".js")).sort();
  const total = sorted.reduce((sum, f) => sum + gzipBytes(join(nextDir, f)), 0);
  return { path, route, files: sorted, gzipBytes: total };
}

/** The Lighthouse key pages of every app. */
export function keyPages(): Record<LighthouseApp, readonly string[]> {
  return {
    atlas: lighthouseTargets.atlas.paths,
    gateway: lighthouseTargets.gateway.paths,
    docs: lighthouseTargets.docs.paths,
  };
}

export interface BudgetRow extends RouteBundle {
  readonly app: LighthouseApp;
  readonly budgetBytes: number;
  readonly pass: boolean;
}

/**
 * Checks every Lighthouse key page of the apps whose builds exist under `repoRoot/apps/<app>/.next`.
 * `ceilings` raises the budget for a page whose remaining overage is recorded with its cause in
 * legal/qa/performance-results.md; a ceiling can only hold a page where it is, never let it grow.
 */
export function checkRouteBudgets(
  repoRoot: string,
  ceilings: Readonly<Record<string, number>> = {},
  pages: Readonly<Record<LighthouseApp, readonly string[]>> = keyPages(),
): BudgetRow[] {
  const rows: BudgetRow[] = [];
  for (const app of Object.keys(pages) as LighthouseApp[]) {
    const nextDir = join(repoRoot, "apps", app, ".next");
    if (!existsSync(join(nextDir, "build-manifest.json"))) continue;
    for (const path of pages[app]) {
      const bundle = routeBundle(nextDir, path);
      const budgetBytes = Math.max(
        webBudgets.routeJavaScriptGzipBytes,
        ceilings[`${app}${path}`] ?? 0,
      );
      rows.push({ ...bundle, app, budgetBytes, pass: bundle.gzipBytes <= budgetBytes });
    }
  }
  return rows;
}

export const kb = (bytes: number) => `${(bytes / 1024).toFixed(0)} KB`;
