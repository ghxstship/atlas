import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { gzipSync } from "node:zlib";
import { webBudgets } from "./budgets.ts";
import { lighthouseTargets, type LighthouseApp } from "./lighthouse.ts";

/**
 * Route JavaScript from a production build, without a browser (Section 18, gate 10). For one page
 * it adds the root main files to every chunk the page's client reference manifest lists for its
 * segments (layouts, page, error and not-found boundaries) and counts each chunk's bytes on the
 * wire, as Lighthouse's `resource-summary:script:size` does: `next start` gzips at zlib's default
 * level, and every response carries its headers and chunked framing (transferBytes). It cannot see
 * the chunks a page fetches after hydration on its own (a module loaded on mount); served-budget.ts
 * measures those in a browser, and the nightly Lighthouse run counts them too.
 */

export interface RouteBundle {
  readonly path: string;
  readonly route: string;
  readonly files: readonly string[];
  /** Bytes on the wire for the route's chunks, as Lighthouse counts them (transferBytes). */
  readonly transferBytes: number;
}

/**
 * What `next start` adds to each script response besides the gzip body: the status line and
 * headers (Cache-Control, ETag, Content-Type, Vary, Content-Encoding, Date, Keep-Alive and
 * Transfer-Encoding come to 395 bytes) and the chunked framing, about 12 bytes per 16 KiB the
 * compressor writes. Measured against Lighthouse 12.6.1 on Next 16.4.2 (A144, 2026-10-28): within
 * 6 bytes of each script's transferSize on the Atlas key pages.
 */
export const RESPONSE_HEADER_BYTES = 395;
export const CHUNK_FRAMING_BYTES = 12;
const FRAME = 16 * 1024;

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

const sizeCache = new Map<string, number>();

/**
 * One script's bytes on the wire from `next start`: its body gzipped at zlib's default level, as
 * Next's compression sends it, plus the response's headers and framing.
 */
export function transferBytes(body: Buffer): number {
  const gzip = gzipSync(body).length;
  return gzip + RESPONSE_HEADER_BYTES + CHUNK_FRAMING_BYTES * Math.ceil(gzip / FRAME);
}

function fileTransferBytes(file: string): number {
  let size = sizeCache.get(file);
  if (size === undefined) {
    size = transferBytes(readFileSync(file));
    sizeCache.set(file, size);
  }
  return size;
}

/** The chunks one route loads on a cold visit and their total bytes on the wire. */
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
  const total = sorted.reduce((sum, f) => sum + fileTransferBytes(join(nextDir, f)), 0);
  return { path, route, files: sorted, transferBytes: total };
}

/** An app whose key pages carry the route JavaScript budget. */
export type BudgetApp = LighthouseApp | "console";

/**
 * Key pages of the operator console (A90). Internal and signed in with a second factor, so Lighthouse does not
 * visit it; its builds still carry the same route JavaScript budget.
 */
export const CONSOLE_KEY_PAGES: readonly string[] = [
  "/auth/sign-in",
  "/tenants",
  "/tenants/00000000-0000-0000-0000-000000000000",
  "/moderation/00000000-0000-0000-0000-000000000000",
  "/banners",
];

/** The Lighthouse key pages of every app, and the console's. */
export function keyPages(): Record<BudgetApp, readonly string[]> {
  return {
    atlas: lighthouseTargets.atlas.paths,
    gateway: lighthouseTargets.gateway.paths,
    docs: lighthouseTargets.docs.paths,
    console: CONSOLE_KEY_PAGES,
  };
}

export interface BudgetRow extends RouteBundle {
  readonly app: BudgetApp;
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
  pages: Readonly<Partial<Record<BudgetApp, readonly string[]>>> = keyPages(),
): BudgetRow[] {
  const rows: BudgetRow[] = [];
  for (const app of Object.keys(pages) as BudgetApp[]) {
    const nextDir = join(repoRoot, "apps", app, ".next");
    if (!existsSync(join(nextDir, "build-manifest.json"))) continue;
    for (const path of pages[app] ?? []) {
      const bundle = routeBundle(nextDir, path);
      const budgetBytes = Math.max(
        webBudgets.routeJavaScriptGzipBytes,
        ceilings[`${app}${path}`] ?? 0,
      );
      rows.push({ ...bundle, app, budgetBytes, pass: bundle.transferBytes <= budgetBytes });
    }
  }
  return rows;
}

export const kb = (bytes: number) => `${(bytes / 1024).toFixed(0)} KB`;
