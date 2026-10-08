import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      thresholds: { lines: 85 },
    },
  },
});
