import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  lighthouseRc,
  lighthouseTargets,
  scorePage,
  sessionCookieHeader,
  type AuthSession,
  type LighthouseApp,
} from "./lighthouse.ts";

/**
 * `pnpm --filter @xos/testing lighthouse [atlas|gateway|docs]` runs Lighthouse CI against running
 * production builds (`next start`) of each app on the local stack and writes
 * node_modules/.cache/lighthouse/<app>/summary.json (kept out of formatting and the finish guard). Environment:
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
const supabaseUrl = process.env["SUPABASE_URL"] ?? "http://127.0.0.1:57421";
const anonKey = process.env["SUPABASE_ANON_KEY"] ?? "";
const baseOverride: Record<LighthouseApp, string | undefined> = {
  atlas: process.env["ATLAS_URL"],
  gateway: process.env["GATEWAY_URL"],
  docs: process.env["DOCS_URL"],
};

async function signIn(email: string): Promise<AuthSession> {
  if (!anonKey) throw new Error("SUPABASE_ANON_KEY is required for signed-in pages.");
  const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: process.env["LH_PASSWORD"] ?? "xos-demo-2026" }),
  });
  if (!res.ok) throw new Error(`Sign-in for ${email} answered ${res.status}: ${await res.text()}`);
  return (await res.json()) as AuthSession;
}

let failed = false;
for (const app of selected) {
  const target = lighthouseTargets[app];
  const baseUrl = baseOverride[app] ?? target.baseUrl;
  const cookie = target.email ? sessionCookieHeader("xos-auth", await signIn(target.email)) : null;
  const outputDir = join(here, "node_modules/.cache/lighthouse", app);
  mkdirSync(outputDir, { recursive: true });
  const rcPath = join(outputDir, "lighthouserc.json");
  writeFileSync(
    rcPath,
    JSON.stringify(
      lighthouseRc({ app, baseUrl, cookie, chromePath: process.env["CHROME_PATH"], outputDir }),
    ),
  );
  const run = spawnSync("pnpm", ["exec", "lhci", "autorun", `--config=${rcPath}`], {
    // lhci keeps its working files (.lighthouseci) in its cwd; keep them with the reports.
    cwd: outputDir,
    stdio: "inherit",
  });
  if (run.status !== 0) failed = true;

  const reports = readdirSync(outputDir).filter((f) => f.endsWith(".report.json"));
  const pages = reports.map((f) => scorePage(JSON.parse(readFileSync(join(outputDir, f), "utf8"))));
  writeFileSync(join(outputDir, "summary.json"), `${JSON.stringify(pages, null, 2)}\n`);
  for (const page of pages) {
    process.stdout.write(
      `${app} ${page.url} perf ${page.performance} a11y ${page.accessibility} LCP ${Math.round(page.lcpMs ?? -1)} ms CLS ${page.cls?.toFixed(3)} TBT ${Math.round(page.tbtMs ?? -1)} ms JS ${Math.round((page.scriptBytes ?? 0) / 1024)} KB ${page.withinBudget ? "within budget" : "OVER BUDGET"}\n`,
    );
  }
}
process.exitCode = failed ? 1 : 0;
