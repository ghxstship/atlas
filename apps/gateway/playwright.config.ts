import { defineConfig, devices } from "@playwright/test";

/**
 * Gateway end-to-end tests (Section 18, gate 6; Section 20.2 Gateway journeys) against a local
 * Supabase stack with the demo seed and a running Gateway. `pnpm --filter @xos/gateway e2e` starts
 * `next dev` on E2E_PORT (3127 by default) unless a server already answers there.
 *
 * E2E_SUPABASE_URL and E2E_DATABASE_URL name the stack (by default the A27 stack on block 569);
 * fixtures connect as postgres to that local stack only, to build the states a journey needs.
 * PLAYWRIGHT_CHROMIUM_EXECUTABLE points at a locally installed Chromium when the pinned build is
 * not installed; CI installs the pinned build with `playwright install chromium`.
 */
const port = Number(process.env["E2E_PORT"] ?? 3127);
const baseURL = process.env["E2E_BASE_URL"] ?? `http://127.0.0.1:${port}`;
const executablePath = process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"];
const supabaseUrl = process.env["E2E_SUPABASE_URL"] ?? "http://127.0.0.1:56921";
// The anon key is the publishable key of every local Supabase stack; RLS guards every row.
const anonKey =
  process.env["E2E_SUPABASE_ANON_KEY"] ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

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
    timeout: 180_000,
    env: {
      SUPABASE_URL: supabaseUrl,
      SUPABASE_ANON_KEY: anonKey,
      GATEWAY_SITE_URL: baseURL,
      GATEWAY_PLATFORM_HOSTS: "127.0.0.1,localhost",
    },
  },
});
