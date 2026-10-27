import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  test: {
    include: ["test/**/*.test.ts"],
    /* Render and catalog loading take several seconds on a loaded CI runner (run 40123982182), as in Atlas. */
    testTimeout: 30_000,
  },
});
