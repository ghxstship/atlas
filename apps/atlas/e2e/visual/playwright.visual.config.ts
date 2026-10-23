import { defineConfig, devices } from "@playwright/test";

/**
 * Core-screen visual regression (Section 18, gate 9; Section 15: RTL visual regression on the core
 * screens). Each Atlas core screen in Dark, Light, right to left (ar-XB) and Sunlight, at 1280 px and
 * 375 px, on the demo seed, with reduced motion and the volatile regions masked (stable.ts). It runs
 * only through this config: spec files here end in `.visual.ts`, which the default match skips.
 *
 * The baselines in __screenshots__ are Linux Chromium renders from mcr.microsoft.com/playwright at
 * the pinned version (linux/amd64, HOME=/root), the image the Storybook baselines and CI use, so the
 * fonts and anti-aliasing match. Every screen is taken at the visual clock (stable.ts): put a local
 * stack with the demo seed on it, start Atlas on `next dev` (ar-XB exists only in development
 * builds) on the same clock, and run this config in that image with
 * packages/testing/ci/visual-in-container.sh:
 *
 *   export $(packages/testing/ci/visual-clock.sh)
 *   NODE_OPTIONS="--require $PWD/packages/testing/clock/node-clock.cjs" pnpm --filter @xos/atlas exec next dev --port 3006
 *   E2E_BASE_URL=http://127.0.0.1:3006 packages/testing/ci/visual-in-container.sh atlas
 *
 * VISUAL_UPDATE_SNAPSHOTS=missing writes baselines that do not exist yet; =changed or =all rewrites
 * them after an intended change. Without E2E_BASE_URL, `next dev` starts on E2E_PORT, on the clock.
 */
// Without the visual clock every screen would show the date of the run and fail for that alone.
const clockOffset = Number(process.env["E2E_CLOCK_OFFSET_MS"] ?? 0);
if (!clockOffset) {
  throw new Error(
    "E2E_CLOCK_OFFSET_MS is not set: put the stack on the visual clock with packages/testing/ci/visual-clock.sh first (playwright.visual.config.ts).",
  );
}
const nodeClock = new URL("../../../../packages/testing/clock/node-clock.cjs", import.meta.url)
  .pathname;
const port = Number(process.env["E2E_PORT"] ?? 3006);
const baseURL = process.env["E2E_BASE_URL"] ?? `http://127.0.0.1:${port}`;
const executablePath = process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"];
const update = process.env["VISUAL_UPDATE_SNAPSHOTS"];
const updateSnapshots =
  update === "missing" || update === "changed" || update === "all" ? update : "none";

const shared = {
  baseURL,
  // A browser that sends Global Privacy Control, which counts as refusing optional cookies, so the
  // cookie banner (A82, Section 14.3) stays out of every screen; the compliance journey opens its
  // own contexts without the signal to test the banner.
  extraHTTPHeaders: { "Sec-GPC": "1" },
  reducedMotion: "reduce" as const,
  locale: "en-US",
  // Dates the browser formats follow the demo tenant's zone wherever the run happens.
  timezoneId: "America/New_York",
  trace: "retain-on-failure" as const,
  ...(executablePath ? { launchOptions: { executablePath } } : {}),
};

export default defineConfig({
  testDir: ".",
  testMatch: /\.visual\.ts$/,
  updateSnapshots,
  fullyParallel: true,
  workers: Number(process.env["VISUAL_WORKERS"] ?? 2),
  retries: process.env["CI"] ? 1 : 0,
  timeout: 120_000,
  reporter: process.env["CI"] ? [["list"], ["github"]] : [["list"]],
  outputDir: "../../node_modules/.cache/playwright-visual",
  snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{arg}{ext}",
  expect: {
    timeout: 20_000,
    // Secondary text is low contrast; the default per-pixel threshold (0.2) would miss a changed label.
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.001,
      threshold: 0.05,
      animations: "disabled",
      scale: "css",
    },
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.visual\.ts$/, use: shared },
    {
      name: "desktop-1280",
      dependencies: ["setup"],
      testIgnore: /auth\.setup\.visual\.ts$/,
      use: { ...devices["Desktop Chrome"], ...shared, viewport: { width: 1280, height: 800 } },
    },
    {
      name: "phone-375",
      dependencies: ["setup"],
      testIgnore: /auth\.setup\.visual\.ts$/,
      use: {
        ...devices["Desktop Chrome"],
        ...shared,
        viewport: { width: 375, height: 812 },
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
  webServer: {
    command: `pnpm exec next dev --port ${port}`,
    url: `${baseURL}/auth/sign-in`,
    reuseExistingServer: true,
    timeout: 180_000,
    cwd: "../..",
    env: { NODE_OPTIONS: `--require ${nodeClock}`, E2E_CLOCK_OFFSET_MS: String(clockOffset) },
  },
});
