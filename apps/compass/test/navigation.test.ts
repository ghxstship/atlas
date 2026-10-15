import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { navigationOutPath, renderNavigation } from "../scripts/navigation";

describe("generated navigation", () => {
  it("matches ia/sitemap.yaml", async () => {
    const expected = await renderNavigation();
    if (process.env["XOS_WRITE_GENERATED"] === "1") writeFileSync(navigationOutPath, expected);
    const current = existsSync(navigationOutPath) ? readFileSync(navigationOutPath, "utf8") : "";
    expect(current, "run pnpm --filter @xos/compass generate:navigation").toBe(expected);
  });
});
