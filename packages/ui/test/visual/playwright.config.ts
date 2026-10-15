import { defineConfig, devices } from "@playwright/test";

/**
 * Storybook visual regression (Section 18 gate 9) and axe (gate 8) over every story. Run after
 * `pnpm --filter @xos/ui storybook:build`. Baselines live in __screenshots__ beside this file;
 * update them with `pnpm --filter @xos/ui test:visual --update-snapshots` after an intended change.
 * The chromium project gates; firefox and webkit run the axe and browser checks (MapView tiles, Yjs
 * co-editing) as the cross-engine pass, without baselines, since font rasterizing differs by engine.
 */
const port = Number(process.env["STORYBOOK_PORT"] ?? 6107);
const executablePath = process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"];

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: true,
  workers: process.env["CI"] ? 2 : 4,
  retries: process.env["CI"] ? 1 : 0,
  timeout: 60_000,
  reporter: [["list"]],
  outputDir: "../../node_modules/.cache/playwright-visual",
  snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{arg}{ext}",
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: "disabled" } },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
        ...(executablePath ? { launchOptions: { executablePath } } : {}),
      },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"], viewport: { width: 1280, height: 800 } },
      grepInvert: /@baseline/,
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 800 } },
      grepInvert: /@baseline/,
    },
  ],
  webServer: {
    command: `node serve.mjs ${port}`,
    url: `http://127.0.0.1:${port}/index.json`,
    reuseExistingServer: !process.env["CI"],
    timeout: 30_000,
  },
});
