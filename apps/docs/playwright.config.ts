import { defineConfig, devices } from "@playwright/test";

/**
 * Accessibility and rendering checks for the docs site. `pnpm --filter @xos/docs e2e` serves the
 * production build on E2E_PORT (3014 by default) unless a server already answers there; run
 * `pnpm --filter @xos/docs build` first. PLAYWRIGHT_CHROMIUM_EXECUTABLE points at a locally
 * installed Chromium when the pinned browser build is not installed.
 */
const port = Number(process.env["E2E_PORT"] ?? 3014);
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
    reducedMotion: "reduce",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `pnpm exec next start --port ${port}`,
    url: `${baseURL}/en-US`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
