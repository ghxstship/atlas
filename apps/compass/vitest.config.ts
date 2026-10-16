import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      /*
       * Compass's tests run in node. They read the Workforce screen list, never render the screens
       * (their React Native components have their own jsdom tests in @xos/workforce-native), so the
       * package resolves to its plain screen list here.
       */
      "@xos/workforce-native": fileURLToPath(
        new URL("../../packages/workforce-native/src/screens.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/domain/**/*.ts"],
      thresholds: { lines: 90 },
    },
  },
});
