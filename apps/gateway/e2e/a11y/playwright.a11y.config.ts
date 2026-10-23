import { defineConfig, devices } from "@playwright/test";

/**
 * The A23 Gateway accessibility sweep (Section 14.1; Section 18, gates 8, 23 and 31). It runs only through its
 * own config, never in `pnpm verify` or the default e2e run: spec files here end in `.a11y.ts`,
 * which the default Playwright match skips.
 *
 *   pnpm --filter @xos/gateway exec playwright test -c e2e/a11y/playwright.a11y.config.ts
 *
 * It signs in as the seeded external people (supabase/seeds/0010: crew and the vendor contact) on a
 * local stack with every seed loaded, and visits every Gateway route each may open, at 1280 px and
 * 375 px, in both themes, with reduced motion. E2E_BASE_URL points at a running Gateway; otherwise
 * `next dev` starts on E2E_PORT. E2E_DATABASE_URL names the stack for token fixtures.
 */
const port = Number(process.env["E2E_PORT"] ?? 3127);
const baseURL = process.env["E2E_BASE_URL"] ?? `http://127.0.0.1:${port}`;
const executablePath = process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"];
const supabaseUrl = process.env["E2E_SUPABASE_URL"] ?? "http://127.0.0.1:56921";
// The anon key is the publishable key of every local Supabase stack; RLS guards every row.
const anonKey =
  process.env["E2E_SUPABASE_ANON_KEY"] ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

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
  reporter: [["list"], ["json", { outputFile: "../../node_modules/.cache/a11y/gateway.json" }]],
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
    env: {
      SUPABASE_URL: supabaseUrl,
      SUPABASE_ANON_KEY: anonKey,
      GATEWAY_SITE_URL: baseURL,
      GATEWAY_PLATFORM_HOSTS: "127.0.0.1,localhost",
    },
  },
});
