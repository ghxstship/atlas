import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { lighthouseRuns } from "./lighthouse-routes.ts";
import { signIn } from "./session.ts";

/**
 * `pnpm --filter @xos/testing lighthouse [atlas|gateway|docs] [--key-pages]` runs Lighthouse CI
 * against running production builds (`next start`) of each app on the local stack: every signed-in
 * route in the generated sitemaps, each visited by a demo person who may open it, and the public
 * key pages (lighthouse-routes.ts); `--key-pages` keeps to the 16 key pages. Each run writes its
 * reports under node_modules/.cache/lighthouse/<app>/<run>/ and each app a summary.json (kept out
 * of formatting and the finish guard). Signed-in runs get the person's session in the browser's
 * cookie jar before each page (src/lighthouse-session.cjs). Environment:
 * - SUPABASE_URL and SUPABASE_ANON_KEY: the local stack, for the signed-in pages;
 * - LH_PASSWORD: the demo password (the seed's shared demo password by default);
 * - CHROME_PATH: the Chromium build to drive;
 * - ATLAS_URL, GATEWAY_URL, DOCS_URL: override the base URLs.
 */
const here = fileURLToPath(new URL("..", import.meta.url));
const apps = (process.argv.slice(2).filter((a) => !a.startsWith("-")) as LighthouseApp[]).filter(
  (a) => a in lighthouseTargets,
);
const selected: LighthouseApp[] = apps.length > 0 ? apps : ["atlas", "gateway", "docs"];
const keyPagesOnly = process.argv.includes("--key-pages");
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
  for (const run of lighthouseRuns(app, keyPagesOnly)) {
    const cookies = run.email ? sessionCookies("xos-auth", await signIn(run.email)) : null;
    const outputDir = join(appDir, run.name);
    mkdirSync(outputDir, { recursive: true });
    const rcPath = join(outputDir, "lighthouserc.json");
    writeFileSync(
      rcPath,
      JSON.stringify(
        lighthouseRc({
          baseUrl,
          paths: run.paths,
          // lhci resolves the script against its cwd.
          sessionScript: cookies
            ? relative(outputDir, join(here, "src/lighthouse-session.cjs"))
            : null,
          chromePath: process.env["CHROME_PATH"],
          outputDir,
        }),
      ),
    );
    process.stdout.write(`${app} ${run.name}: ${run.paths.length} pages\n`);
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
    pages.push(
      ...reports.map((f) => scorePage(JSON.parse(readFileSync(join(outputDir, f), "utf8")))),
    );
  }

  pages.sort((a, b) => a.url.localeCompare(b.url));
  writeFileSync(join(appDir, "summary.json"), `${JSON.stringify(pages, null, 2)}\n`);
  for (const page of pages) {
    process.stdout.write(
      `${app} ${page.url} perf ${page.performance} a11y ${page.accessibility} LCP ${Math.round(page.lcpMs ?? -1)} ms CLS ${page.cls?.toFixed(3)} TBT ${Math.round(page.tbtMs ?? -1)} ms JS ${Math.round((page.scriptBytes ?? 0) / 1024)} KB ${page.withinBudget ? "within budget" : "OVER BUDGET"}\n`,
    );
  }
  const over = pages.filter((p) => !p.withinBudget).length;
  process.stdout.write(`${app}: ${pages.length - over} of ${pages.length} pages within budget\n`);
}
process.exitCode = failed ? 1 : 0;
