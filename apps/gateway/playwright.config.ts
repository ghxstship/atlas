import { defineConfig, devices, type Project } from "@playwright/test";

/**
 * Gateway end-to-end tests (Section 18, gate 6; Section 20.2 Gateway journeys) against a local
 * Supabase stack with the demo seed and a running Gateway. `pnpm --filter @xos/gateway e2e` starts
 * `next dev` on E2E_PORT (3127 by default) unless a server already answers there; start
 * `next start` first to run the journeys against a production build.
 *
 * The external role journeys cross into Atlas for the org's side (journeys 4, 29, 41 to 48 and
 * 59 to 62), so Atlas is started too, on E2E_ATLAS_URL (http://127.0.0.1:3006 by default), unless
 * it already answers there. Each person drives their own browser context.
 *
 * E2E_SUPABASE_URL and E2E_DATABASE_URL name the stack (by default the A27 stack on block 569);
 * fixtures connect as postgres to that local stack only, to build the states a journey needs.
 *
 * Section 18, gate 6: the journeys run in Chromium, Firefox and WebKit, plus a phone viewport.
 * E2E_ENGINES narrows the desktop engines (for example `E2E_ENGINES=chromium`); all three run by
 * default. With WebKit, `ios-safari` (an iPhone) and `ipados-safari` (an iPad) stand for Safari on
 * iOS and iPadOS (Section 4.10, ADR 0027): the phone journeys and the tablet journeys in WebKit's
 * mobile emulation. PLAYWRIGHT_CHROMIUM_EXECUTABLE, PLAYWRIGHT_FIREFOX_EXECUTABLE and
 * PLAYWRIGHT_WEBKIT_EXECUTABLE point at locally installed browsers when the pinned builds are not
 * installed; CI installs the pinned builds with `playwright install chromium firefox webkit`.
 */
const port = Number(process.env["E2E_PORT"] ?? 3127);
const baseURL = process.env["E2E_BASE_URL"] ?? `http://127.0.0.1:${port}`;
const atlasURL = process.env["E2E_ATLAS_URL"] ?? "http://127.0.0.1:3006";
const supabaseUrl = process.env["E2E_SUPABASE_URL"] ?? "http://127.0.0.1:56921";
// The anon key is the publishable key of every local Supabase stack; RLS guards every row.
const anonKey =
  process.env["E2E_SUPABASE_ANON_KEY"] ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const engines = new Set(
  (process.env["E2E_ENGINES"] ?? "chromium,firefox,webkit").split(",").map((e) => e.trim()),
);

/** Launch options naming a locally installed browser, when the variable is set. */
function launch(variable: string) {
  const executablePath = process.env[variable];
  return executablePath ? { launchOptions: { executablePath } } : {};
}

/** Safari on iOS and iPadOS, run with the WebKit engine. */
const webkitMobile: Project[] = [
  {
    name: "ios-safari",
    use: { ...devices["iPhone 17"], ...launch("PLAYWRIGHT_WEBKIT_EXECUTABLE") },
    testMatch: /mobile\.spec\.ts/,
  },
  {
    name: "ipados-safari",
    use: { ...devices["iPad Pro 11"], ...launch("PLAYWRIGHT_WEBKIT_EXECUTABLE") },
    testMatch: /tablet\.spec\.ts/,
  },
];

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
  timeout: 90_000,
  reporter: [["list"]],
  outputDir: "node_modules/.cache/playwright",
  use: {
    baseURL,
    // A browser that sends Global Privacy Control, which counts as refusing optional cookies, so the
    // cookie banner (A82, Section 14.3) stays out of every screen; e2e/compliance.spec.ts opens its
    // own contexts without the signal to test the banner.
    extraHTTPHeaders: { "Sec-GPC": "1" },
    trace: "retain-on-failure",
    // A missing control fails the step in seconds instead of holding the whole test timeout.
    actionTimeout: 20_000,
    // E2E_TIMEZONE runs the browsers in that zone, for example America/New_York with the test clock
    // at 23:30 there (e2e/engine-test.ts, packages/testing/clock).
    ...(process.env["E2E_TIMEZONE"] ? { timezoneId: process.env["E2E_TIMEZONE"] } : {}),
  },
  projects: [
    ...desktop
      .filter((p) => engines.has(p.name ?? ""))
      .map((p) => ({ ...p, testIgnore: /(mobile|tablet)\.spec\.ts/ })),
    {
      name: "mobile",
      use: { ...devices["Pixel 7"], ...launch("PLAYWRIGHT_CHROMIUM_EXECUTABLE") },
      testMatch: /mobile\.spec\.ts/,
    },
    ...(engines.has("webkit") ? webkitMobile : []),
  ],
  webServer: [
    {
      command: `pnpm exec next dev --port ${port}`,
      url: `${baseURL}/auth/sign-in`,
      reuseExistingServer: true,
      timeout: 180_000,
      env: {
        SUPABASE_URL: supabaseUrl,
        SUPABASE_ANON_KEY: anonKey,
        GATEWAY_SITE_URL: baseURL,
        GATEWAY_PLATFORM_HOSTS: "127.0.0.1,localhost",
      },
    },
    {
      command: `pnpm --filter @xos/atlas exec next dev --port ${new URL(atlasURL).port}`,
      url: `${atlasURL}/auth/sign-in`,
      reuseExistingServer: true,
      timeout: 180_000,
    },
  ],
});
