import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against the local Supabase stack (554xx, supabase/config.toml) and a running
 * Atlas. `pnpm --filter @xos/atlas e2e` starts `next dev` on E2E_PORT (3006 by default) with
 * apps/atlas/.env.local unless a server already answers there.
 * PLAYWRIGHT_CHROMIUM_EXECUTABLE points at a locally installed Chromium when the pinned browser
 * build is not installed; CI installs the pinned build with `playwright install chromium`.
 */
const port = Number(process.env["E2E_PORT"] ?? 3006);
const baseURL = process.env["E2E_BASE_URL"] ?? `http://127.0.0.1:${port}`;
const executablePath = process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"];

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
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: /mobile\.spec\.ts/ },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: {
    command: `pnpm exec next dev --port ${port}`,
    url: `${baseURL}/auth/sign-in`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
