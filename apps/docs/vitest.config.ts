import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  // tsconfig leaves JSX to Next (`preserve`); tests that render a component compile it themselves.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 120000,
  },
});
