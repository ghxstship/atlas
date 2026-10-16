import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 600000,
    coverage: {
      provider: "v8",
      include: ["src/runtime/**/*.ts", "codegen/**/*.ts"],
      thresholds: { lines: 85 },
    },
  },
});
