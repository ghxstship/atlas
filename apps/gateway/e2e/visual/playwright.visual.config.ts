import { defineConfig, devices } from "@playwright/test";

/**
 * Core-screen visual regression (Section 18, gate 9; Section 15: RTL visual regression on the core
 * screens). Each Gateway core screen in Dark, Light, right to left (ar-XB) and Sunlight, at 1280 px
 * and 375 px, on the demo seed, with reduced motion and the volatile regions masked (stable.ts). It
 * runs only through this config: spec files here end in `.visual.ts`, which the default match skips.
 *
 * The baselines in __screenshots__ are Linux Chromium renders from mcr.microsoft.com/playwright at
 * the pinned version (linux/amd64, HOME=/root), the image the Storybook baselines and CI use, so the
 * fonts and anti-aliasing match. Run it in that image with packages/testing/ci/visual-in-container.sh
 * against a running Gateway on `next dev` (ar-XB exists only in development builds) and a local
 * stack with the demo seed:
 *
 *   E2E_BASE_URL=http://127.0.0.1:3127 packages/testing/ci/visual-in-container.sh gateway
 *
 * VISUAL_UPDATE_SNAPSHOTS=missing writes baselines that do not exist yet; =changed or =all rewrites
 * them after an intended change. Without E2E_BASE_URL, `next dev` starts on E2E_PORT.
 */
const port = Number(process.env["E2E_PORT"] ?? 3127);
const supabaseUrl = process.env["E2E_SUPABASE_URL"] ?? "http://127.0.0.1:56921";
// The anon key is the publishable key of every local Supabase stack; RLS guards every row.
const anonKey =
  process.env["E2E_SUPABASE_ANON_KEY"] ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
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
    env: {
      SUPABASE_URL: supabaseUrl,
      SUPABASE_ANON_KEY: anonKey,
      GATEWAY_SITE_URL: baseURL,
      GATEWAY_PLATFORM_HOSTS: "127.0.0.1,localhost",
    },
  },
});
