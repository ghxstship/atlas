import { defineConfig, devices } from "@playwright/test";

/**
 * The A23 accessibility sweep (Section 14.1; Section 18, gates 8 and 31). It runs only through its
 * own config, never in `pnpm verify` or the default e2e run: spec files here end in `.a11y.ts`,
 * which the default Playwright match skips.
 *
 *   pnpm --filter @xos/atlas exec playwright test -c e2e/a11y/playwright.a11y.config.ts
 *
 * It signs in as the seeded demo people (supabase/seeds/0010) on a local stack with every seed
 * loaded, and visits every Atlas sitemap route each role may open, at 1280 px and 375 px, in dark
 * and light themes, with reduced motion. E2E_BASE_URL points at a running Atlas; otherwise
 * `next dev` starts on E2E_PORT. A11Y_ROLES limits the roles (comma separated).
 */
const port = Number(process.env["E2E_PORT"] ?? 3006);
const baseURL = process.env["E2E_BASE_URL"] ?? `http://127.0.0.1:${port}`;
const executablePath = process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"];

const shared = {
  baseURL,
  // A browser that sends Global Privacy Control, which counts as refusing optional cookies, so the
  // cookie banner (A82, Section 14.3) stays out of every screen; the compliance journey opens its
  // own contexts without the signal to test the banner.
  extraHTTPHeaders: { "Sec-GPC": "1" },
  reducedMotion: "reduce" as const,
  // The theme switch injects a style that stops transitions; the app CSP would refuse it.
  bypassCSP: true,
  trace: "retain-on-failure" as const,
  ...(executablePath ? { launchOptions: { executablePath } } : {}),
};

export default defineConfig({
  testDir: ".",
  testMatch: /\.a11y\.ts$/,
  fullyParallel: true,
  workers: Number(process.env["A11Y_WORKERS"] ?? 4),
  retries: 0,
  timeout: 90_000,
  reporter: [["list"], ["json", { outputFile: "../../node_modules/.cache/a11y/atlas.json" }]],
  outputDir: "../../node_modules/.cache/playwright-a11y",
  projects: [
    { name: "setup", testMatch: /auth\.setup\.a11y\.ts$/, use: shared },
    {
      name: "desktop-1280",
      dependencies: ["setup"],
      testIgnore: /auth\.setup\.a11y\.ts$/,
      use: { ...devices["Desktop Chrome"], ...shared, viewport: { width: 1280, height: 800 } },
    },
    {
      name: "phone-375",
      dependencies: ["setup"],
      testIgnore: /auth\.setup\.a11y\.ts$/,
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
    timeout: 120_000,
    cwd: "../..",
  },
});
