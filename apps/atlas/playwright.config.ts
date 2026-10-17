import { defineConfig, devices, type Project } from "@playwright/test";

/**
 * End-to-end tests against the local Supabase stack (554xx, supabase/config.toml) and a running
 * Atlas. `pnpm --filter @xos/atlas e2e` starts `next dev` on E2E_PORT (3006 by default) with
 * apps/atlas/.env.local unless a server already answers there; start `next start` first to run the
 * journeys against a production build.
 *
 * Section 18, gate 6: the journeys run in Chromium, Firefox and WebKit, plus a phone viewport.
 * E2E_ENGINES narrows the desktop engines (for example `E2E_ENGINES=chromium`); all three run by
 * default. PLAYWRIGHT_CHROMIUM_EXECUTABLE, PLAYWRIGHT_FIREFOX_EXECUTABLE and
 * PLAYWRIGHT_WEBKIT_EXECUTABLE point at locally installed browsers when the pinned builds are not
 * installed; CI installs the pinned builds with `playwright install chromium firefox webkit`.
 */
const port = Number(process.env["E2E_PORT"] ?? 3006);
const baseURL = process.env["E2E_BASE_URL"] ?? `http://127.0.0.1:${port}`;
const auroraURL = process.env["E2E_AURORA_URL"] ?? "http://127.0.0.1:3016";
const engines = new Set(
  (process.env["E2E_ENGINES"] ?? "chromium,firefox,webkit").split(",").map((e) => e.trim()),
);

/** Launch options naming a locally installed browser, when the variable is set. */
function launch(variable: string) {
  const executablePath = process.env[variable];
  return executablePath ? { launchOptions: { executablePath } } : {};
}

const desktop: Project[] = [
  {
    name: "chromium",
    use: { ...devices["Desktop Chrome"], ...launch("PLAYWRIGHT_CHROMIUM_EXECUTABLE") },
  },
  {
    name: "firefox",
    use: { ...devices["Desktop Firefox"], ...launch("PLAYWRIGHT_FIREFOX_EXECUTABLE") },
  },
  {
    name: "webkit",
    use: { ...devices["Desktop Safari"], ...launch("PLAYWRIGHT_WEBKIT_EXECUTABLE") },
  },
];

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env["CI"] ? 1 : 0,
  timeout: 60_000,
  reporter: [["list"]],
  // Kept under node_modules so formatters and the finish guard never scan run output.
  outputDir: "node_modules/.cache/playwright",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    ...desktop
      .filter((p) => engines.has(p.name ?? ""))
      .map((p) => ({ ...p, testIgnore: /mobile\.spec\.ts/ })),
    {
      name: "mobile",
      use: { ...devices["Pixel 7"], ...launch("PLAYWRIGHT_CHROMIUM_EXECUTABLE") },
      testMatch: /mobile\.spec\.ts/,
    },
  ],
  webServer: [
    {
      command: `pnpm exec next dev --port ${port}`,
      url: `${baseURL}/auth/sign-in`,
      reuseExistingServer: true,
      timeout: 120_000,
    },
    // Journeys 35 and 36 (aurora-journeys.spec.ts) need Aurora's fixture model, which exists only
    // outside production (finding A24-007), so they run against their own development server.
    {
      command: `pnpm exec next dev --port ${new URL(auroraURL).port}`,
      url: `${auroraURL}/auth/sign-in`,
      reuseExistingServer: true,
      timeout: 180_000,
      env: { XOS_AI_FAKE: "1", ATLAS_SITE_URL: auroraURL },
    },
  ],
});
