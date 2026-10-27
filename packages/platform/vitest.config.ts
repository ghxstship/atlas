import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    /* The first email render imports @react-email and every template, about half a second on a
       laptop and past vitest's 5 s default on a loaded CI runner (run 40096408024). */
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      thresholds: { lines: 85 },
    },
  },
});
