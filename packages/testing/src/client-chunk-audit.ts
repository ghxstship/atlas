import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Code that must never reach a browser bundle. The Sentry browser SDK is about 30 KB gzip, more
 * than any route's headroom under the ADR 0027 budgets, so browsers report errors through the
 * same-origin reporter in `@xos/infra/observability/browser` instead (ADR 0025), and Sentry stays
 * on the server. The patterns are strings every Sentry SDK build carries: its global carrier,
 * its SDK name, its auth parameter and its ingest host.
 */
export const FORBIDDEN_CLIENT_CODE: ReadonlyArray<{
  readonly name: string;
  readonly pattern: RegExp;
}> = [
  {
    name: "Sentry SDK",
    pattern: /__SENTRY__|sentry\.javascript\.|sentry_key=|\.ingest\.(?:[a-z]+\.)?sentry\.io/,
  },
];

export interface ForbiddenHit {
  readonly app: string;
  readonly file: string;
  readonly name: string;
}

function scriptsUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...scriptsUnder(path));
    else if (entry.name.endsWith(".js")) out.push(path);
  }
  return out;
}

/**
 * Scans every script under `apps/<app>/.next/static` (what the browser can load) for forbidden
 * code. Apps without a production build are skipped; `apps` lists which apps were scanned.
 */
export function findForbiddenClientCode(
  repoRoot: string,
  apps: readonly string[] = ["atlas", "gateway", "docs"],
): { readonly scanned: readonly string[]; readonly hits: readonly ForbiddenHit[] } {
  const scanned: string[] = [];
  const hits: ForbiddenHit[] = [];
  for (const app of apps) {
    const staticDir = join(repoRoot, "apps", app, ".next", "static");
    if (!existsSync(staticDir)) continue;
    scanned.push(app);
    for (const file of scriptsUnder(staticDir)) {
      const text = readFileSync(file, "utf8");
      for (const { name, pattern } of FORBIDDEN_CLIENT_CODE) {
        if (pattern.test(text)) hits.push({ app, file: relative(staticDir, file), name });
      }
    }
  }
  return { scanned, hits };
}
