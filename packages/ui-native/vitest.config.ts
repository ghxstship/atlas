import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const shim = (name: string) => fileURLToPath(new URL(`./test/shims/${name}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "react-native-svg": shim("react-native-svg.tsx"),
      "react-native": shim("react-native.tsx"),
      /* Same icon names and props at the shared 1.53.0 pin; renders as DOM SVG under jsdom. */
      "lucide-react-native": "lucide-react",
    },
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["test/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/index.ts", "src/types.ts", "src/icons.generated.ts"],
      thresholds: { lines: 85 },
    },
  },
});
