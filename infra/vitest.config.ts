import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["*/test/**/*.test.ts"],
    // These suites read the whole repository (migrations, sources, workflows) and run git and shell scripts; under CI's
    // parallel turbo run some take ten times as long as alone, past the 5 s default.
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["*/src/**/*.ts"],
      exclude: ["*/src/cli.ts"],
      thresholds: { lines: 85 },
    },
  },
});
