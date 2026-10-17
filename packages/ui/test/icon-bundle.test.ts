// @vitest-environment node
import { fileURLToPath } from "node:url";
import { build } from "vite";
import type { Rollup } from "vite";
import { describe, expect, it } from "vitest";
import { registeredIconNames } from "@xos/icons/names";

/**
 * ADR 0027 (after RRR-70): a production bundle of the Icon component carries no icon geometry and
 * no icon name list. Icons draw from the sprite file, which the bundle references as an asset.
 */
describe("Icon bundle", () => {
  it("ships no lucide-react icon and references the sprite as an asset", async () => {
    const entry = fileURLToPath(new URL("../src/Icon/Icon.tsx", import.meta.url));
    const result = await build({
      configFile: false,
      logLevel: "silent",
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      build: {
        write: false,
        minify: false,
        assetsInlineLimit: 0,
        // Library mode inlines every asset, so build the entry as an app chunk instead.
        rollupOptions: {
          input: entry,
          preserveEntrySignatures: "strict",
          external: ["react", "react/jsx-runtime", "react-dom"],
        },
      },
    });
    const outputs = (Array.isArray(result) ? result : [result]) as Rollup.RollupOutput[];
    const files = outputs.flatMap((o) => o.output);
    const code = files.map((f) => (f.type === "chunk" ? f.code : "")).join("\n");
    expect(code).not.toMatch(/size: 24,/);
    expect(code).not.toContain("createLucideIcon");
    // The registry's names stay out of production bundles.
    expect(code).not.toContain(`"${registeredIconNames[0]}"`);
    const sprite = files.find((f) => f.type === "asset" && f.fileName.endsWith(".svg"));
    expect(sprite?.fileName).toMatch(/sprite\.generated-[\w-]+\.svg$/);
    expect(code).toContain(sprite?.fileName ?? "missing");
  });
});
