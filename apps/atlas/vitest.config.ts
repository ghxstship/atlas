import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  test: {
    include: ["test/**/*.test.ts", "app/**/*.test.ts"],
    // Whole-catalog and whole-sitemap checks take several seconds on CI runners under coverage.
    testTimeout: 30_000,
  },
});
