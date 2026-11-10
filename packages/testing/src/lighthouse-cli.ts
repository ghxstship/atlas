import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  lighthouseRc,
  lighthouseTargets,
  scorePage,
  SESSION_COOKIES_ENV,
  sessionCookies,
  type LighthouseApp,
  type PageScore,
} from "./lighthouse.ts";
import { realtimeClientGzipBytes, webBudgets } from "./budgets.ts";
import { batches, cookieHeader, landingPaths } from "./lighthouse-landing.ts";
import { lighthouseRuns } from "./lighthouse-routes.ts";
import { findRealtimeChunks } from "./realtime-chunk.ts";
import { signIn } from "./session.ts";

/**
 * `pnpm --filter @xos/testing lighthouse [atlas|gateway|docs] [--key-pages]` runs Lighthouse CI
 * against running production builds (`next start`) of each app on the local stack: every signed-in
 * route in the generated sitemaps, each visited by a demo person who may open it, and the public
 * key pages (lighthouse-routes.ts); `--key-pages` keeps to the 16 key pages. A person signs in
 * afresh for each batch of 40 pages, well inside the hour a session lasts, and each page that
 * redirects is visited at its landing path (lighthouse-landing.ts). Each batch writes its reports
 * under node_modules/.cache/lighthouse/<app>/<run>[-<n>]/ and each app a summary.json (kept out of
 * formatting and the finish guard). Signed-in runs get the person's session in the browser's cookie
 * jar before each page (src/lighthouse-session.cjs). The run fails when lhci does, and when any page
 * is over a budget or ended on another URL than it asked for. The Realtime client's chunks, found in
 * the app's build (realtime-chunk.ts), are not part of a page's script budget: they answer to their
 * own 20 KB on the page's line (ADR 0027, owner decision of 2026-11-06). Environment:
 * - SUPABASE_URL and SUPABASE_ANON_KEY: the local stack, for the signed-in pages;
 * - LH_PASSWORD: the demo password (the seed's shared demo password by default);
 * - CHROME_PATH: the Chromium build to drive;
 * - ATLAS_URL, GATEWAY_URL, DOCS_URL: override the base URLs;
 * - LH_ONLY: a comma-separated list of paths to keep to (each as the route lists it, `/demo-productions/work`), to
 *   measure a few pages without the whole run.
 */
const here = fileURLToPath(new URL("..", import.meta.url));
const apps = (process.argv.slice(2).filter((a) => !a.startsWith("-")) as LighthouseApp[]).filter(
  (a) => a in lighthouseTargets,
);
const selected: LighthouseApp[] = apps.length > 0 ? apps : ["atlas", "gateway", "docs"];
const keyPagesOnly = process.argv.includes("--key-pages");
const only = new Set(
  (process.env["LH_ONLY"] ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== ""),
);
/** Pages still over 200 KB hold a recorded ceiling (ADR 0027), keyed `<app><path>`. */
const recorded = (
  JSON.parse(readFileSync(join(here, "bundle-ceilings.json"), "utf8")) as {
    pages: Record<string, number>;
  }
).pages;
const baseOverride: Record<LighthouseApp, string | undefined> = {
  atlas: process.env["ATLAS_URL"],
  gateway: process.env["GATEWAY_URL"],
  docs: process.env["DOCS_URL"],
};

let failed = false;
for (const app of selected) {
  const baseUrl = baseOverride[app] ?? lighthouseTargets[app].baseUrl;
  const appDir = join(here, "node_modules/.cache/lighthouse", app);
  rmSync(appDir, { recursive: true, force: true });
  const pages: PageScore[] = [];
  // The served build's Realtime client (none in docs), so its bytes are counted on their own.
  const nextDir = join(here, "../../apps", app, ".next");
  const realtime = existsSync(join(nextDir, "static/chunks"))
    ? findRealtimeChunks(nextDir).map((c) => c.name)
    : [];
  const ceilings = Object.fromEntries(
    Object.entries(recorded).flatMap(([key, bytes]) =>
      key.startsWith(`${app}/`) ? [[key.slice(app.length), bytes]] : [],
    ),
  );
  // Each landing path once per app; a person signs in afresh for every batch of pages.
  const seen = new Set<string>();
  for (const run of lighthouseRuns(app, keyPagesOnly)) {
    const parts = batches(only.size > 0 ? run.paths.filter((p) => only.has(p)) : run.paths);
    for (const [index, part] of parts.entries()) {
      const cookies = run.email ? sessionCookies("xos-auth", await signIn(run.email)) : null;
      const paths = await landingPaths(baseUrl, part, cookieHeader(cookies), seen);
      if (paths.length === 0) continue;
      const name = parts.length > 1 ? `${run.name}-${index + 1}` : run.name;
      const outputDir = join(appDir, name);
      mkdirSync(outputDir, { recursive: true });
      const rcPath = join(outputDir, "lighthouserc.json");
      writeFileSync(
        rcPath,
        JSON.stringify(
          lighthouseRc({
            baseUrl,
            paths,
            // lhci resolves the script against its cwd.
            sessionScript: cookies
              ? relative(outputDir, join(here, "src/lighthouse-session.cjs"))
              : null,
            chromePath: process.env["CHROME_PATH"],
            outputDir,
            ceilings,
            realtimeClient: realtime.length > 0,
          }),
        ),
      );
      process.stdout.write(`${app} ${name}: ${paths.length} pages\n`);
      // The package's lhci binary, run directly: `pnpm exec` would move to the package root.
      const lhci = spawnSync(
        join(here, "node_modules/.bin/lhci"),
        ["autorun", `--config=${rcPath}`],
        {
          // lhci keeps its working files (.lighthouseci) in its cwd and resolves the session script
          // against it; keep them with the reports.
          cwd: outputDir,
          stdio: "inherit",
          env: cookies
            ? { ...process.env, [SESSION_COOKIES_ENV]: JSON.stringify(cookies) }
            : process.env,
        },
      );
      if (lhci.status !== 0) failed = true;
      const reports = readdirSync(outputDir).filter((f) => f.endsWith(".report.json"));
      for (const f of reports) {
        const result = JSON.parse(readFileSync(join(outputDir, f), "utf8")) as {
          requestedUrl: string;
        };
        const path = new URL(result.requestedUrl).pathname;
        pages.push(
          scorePage(
            result,
            Math.max(webBudgets.routeJavaScriptGzipBytes, ceilings[path] ?? 0),
            realtime,
          ),
        );
      }
    }
  }

  pages.sort((a, b) => a.url.localeCompare(b.url));
  writeFileSync(join(appDir, "summary.json"), `${JSON.stringify(pages, null, 2)}\n`);
  for (const page of pages) {
    const verdict = !page.landed
      ? `ENDED ON ${page.finalUrl}`
      : page.withinBudget
        ? "within budget"
        : "OVER BUDGET";
    const realtimeNote =
      page.realtimeBytes > 0
        ? ` (Realtime client ${Math.round(page.realtimeBytes / 1024)} of ${realtimeClientGzipBytes / 1024} KB apart)`
        : "";
    process.stdout.write(
      `${app} ${page.url} perf ${page.performance} a11y ${page.accessibility} LCP ${Math.round(page.lcpMs ?? -1)} ms CLS ${page.cls?.toFixed(3)} TBT ${Math.round(page.tbtMs ?? -1)} ms JS ${Math.round((page.scriptBytes ?? 0) / 1024)} KB${realtimeNote} ${verdict}\n`,
    );
  }
  // lhci asserts a report by its final URL, so a page that ended elsewhere went unasserted: the
  // summary's own verdict fails the run too.
  const over = pages.filter((p) => !p.landed || !p.withinBudget).length;
  if (over > 0) failed = true;
  process.stdout.write(`${app}: ${pages.length - over} of ${pages.length} pages within budget\n`);
}
process.exitCode = failed ? 1 : 0;
