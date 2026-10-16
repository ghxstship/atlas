import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The CLIs and the Playwright helpers run in their own processes and browsers.
      exclude: ["src/**/*-cli.ts", "src/playwright.ts"],
      thresholds: { lines: 85 },
    },
  },
});
