import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUNDLE_PATH, EDGE_EXTERNALS, FUNCTION_BUNDLES, renderBundle } from "../edge/build.ts";

const denoConfig = JSON.parse(
  readFileSync(new URL("../../../supabase/functions/deno.json", import.meta.url), "utf8"),
) as { imports: Record<string, string> };
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies: Record<string, string>;
};

describe("Edge Function bundle", () => {
  it("is regenerated, never hand-edited (Section 3.15)", async () => {
    expect(readFileSync(BUNDLE_PATH, "utf8")).toBe(await renderBundle());
  }, 120_000);

  it("builds search-embed its own bundle with no npm package, so it boots inside the CPU limit", async () => {
    const bundle = readFileSync(FUNCTION_BUNDLES["search-embed"], "utf8");
    expect(bundle).toBe(await renderBundle("search-embed"));
    expect(bundle).not.toMatch(/^import /m);
    expect(bundle.length).toBeLessThan(40_000);
  }, 120_000);

  it("maps every external package to a pinned npm specifier in deno.json", () => {
    for (const name of EDGE_EXTERNALS) {
      expect(denoConfig.imports[name], name).toMatch(/^npm:(@[^@]+|[^@]+)@\d+\.\d+\.\d+(\/.*)?$/);
    }
  });

  it("pins the packages @xos/platform itself depends on to the same versions", () => {
    for (const name of ["stripe", "zod", "@supabase/supabase-js"]) {
      expect(denoConfig.imports[name]).toBe(`npm:${name}@${manifest.dependencies[name]}`);
    }
  });
});
