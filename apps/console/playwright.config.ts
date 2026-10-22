import { defineConfig, devices, type Project } from "@playwright/test";

/**
 * Console end-to-end journeys (A90; Section 18, gate 6) against a local Supabase stack with the demo seed.
 * `pnpm --filter @xos/console e2e` starts `next dev` for the console on E2E_PORT (3390 by default) unless a server
 * already answers there. The banner journey crosses into Atlas (E2E_ATLAS_URL) and Gateway (E2E_GATEWAY_URL), which
 * must already be running against the same stack.
 *
 * E2E_SUPABASE_URL and E2E_DATABASE_URL name the stack (by default the main local stack on block 554); fixtures
 * connect as postgres to that local stack only, to make operators and reported listings.
 *
 * E2E_ENGINES narrows the desktop engines (for example `E2E_ENGINES=chromium`); all three run by default.
 */
const port = Number(process.env["E2E_PORT"] ?? 3390);
const baseURL = process.env["E2E_BASE_URL"] ?? `http://127.0.0.1:${port}`;
const supabaseUrl = process.env["E2E_SUPABASE_URL"] ?? "http://127.0.0.1:55421";
// The anon key is the publishable key of every local Supabase stack.
const anonKey =
  process.env["E2E_SUPABASE_ANON_KEY"] ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const engines = new Set(
  (process.env["E2E_ENGINES"] ?? "chromium,firefox,webkit").split(",").map((e) => e.trim()),
);

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
  // Server actions and first compiles run long on a loaded machine, so waits are generous.
  timeout: 300_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  outputDir: "node_modules/.cache/playwright",
  use: { baseURL, trace: "retain-on-failure", actionTimeout: 45_000, navigationTimeout: 90_000 },
  projects: desktop.filter((p) => engines.has(p.name ?? "")),
  webServer: [
    {
      command: `pnpm exec next dev --port ${port}`,
      url: `${baseURL}/auth/sign-in`,
      reuseExistingServer: true,
      timeout: 180_000,
      env: {
        SUPABASE_URL: supabaseUrl,
        SUPABASE_ANON_KEY: anonKey,
        CONSOLE_SITE_URL: baseURL,
      },
    },
  ],
});
