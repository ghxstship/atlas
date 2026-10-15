// @vitest-environment node
import { fileURLToPath } from "node:url";
import { build } from "vite";
import type { Rollup } from "vite";
import { describe, expect, it } from "vitest";
import { iconRegistry } from "@xos/icons";

/**
 * RRR-70: a production bundle of the Icon component carries only the @xos/icons registry, never the
 * whole lucide-react namespace.
 */
describe("Icon bundle", () => {
  it("tree-shakes lucide-react down to the registered icons", async () => {
    const entry = fileURLToPath(new URL("../src/Icon/Icon.tsx", import.meta.url));
    const result = await build({
      configFile: false,
      logLevel: "silent",
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      build: {
        write: false,
        minify: false,
        lib: { entry, formats: ["es"], fileName: "icon" },
        rollupOptions: { external: ["react", "react/jsx-runtime", "react-dom"] },
      },
    });
    const outputs = (Array.isArray(result) ? result : [result]) as Rollup.RollupOutput[];
    const code = outputs
      .flatMap((o) => o.output)
      .map((chunk) => (chunk.type === "chunk" ? chunk.code : ""))
      .join("\n");
    const bundled = new Set(
      [...code.matchAll(/name: "([a-z0-9-]+)",\s*size: 24,/g)].map((m) => m[1]),
    );
    expect(bundled.size).toBe(new Set(Object.values(iconRegistry)).size);
    expect(bundled.has("airplay")).toBe(false);
  });
});
