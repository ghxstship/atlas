import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Each suite loads the Bible and the Playbook and generates the canon before its tests: 70 to 80 s
    // a suite on a CI runner, and past 120 s when the runner is loaded.
    testTimeout: 300_000,
    hookTimeout: 300_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/cli.ts"],
      thresholds: { lines: 85 },
    },
  },
});
