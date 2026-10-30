import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The CLIs and the Playwright helpers run in their own processes and browsers. The watch's unit tests run it
      // rebuilt from its source, as the page does, so coverage cannot see it.
      exclude: ["src/**/*-cli.ts", "src/playwright.ts", "src/watch.ts"],
      thresholds: { lines: 85 },
    },
  },
});
