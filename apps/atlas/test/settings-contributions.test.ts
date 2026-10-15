import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { describe, expect, it } from "vitest";
import { getNode } from "@xos/ia";
import { SETTINGS } from "@xos/schemas/settings";
import { renderContributionsIndex } from "../components/settings/contributions/render-index";
import { sitemap } from "../ia/sitemap.generated";

/**
 * The settings contributions index (ADR 0021 pattern). Runs with XOS_WRITE_GENERATED=1 to write
 * index.generated.ts; every other run fails on drift. Also checks that every registry setting
 * names settings pages that exist.
 */
const dir = fileURLToPath(new URL("../components/settings/contributions/", import.meta.url));
const target = `${dir}index.generated.ts`;
const expected = await format(renderContributionsIndex(readdirSync(dir)), {
  ...((await resolveConfig(target)) ?? {}),
  filepath: target,
});
if (process.env["XOS_WRITE_GENERATED"] === "1") writeFileSync(target, expected);

describe("settings contributions", () => {
  it("lists every contributor file", () => {
    expect(existsSync(target) ? readFileSync(target, "utf8") : "").toBe(expected);
  });

  it("renders sorted imports and skips helpers", () => {
    expect(
      renderContributionsIndex(["b-two.tsx", "a1.tsx", "types.ts", "index.generated.ts"]),
    ).toContain(
      'import { contributions as from_a1 } from "./a1";\nimport { contributions as from_b_two } from "./b-two";',
    );
  });
});

describe("settings registry pages", () => {
  it("names only settings pages in the sitemap", () => {
    for (const s of SETTINGS) {
      for (const page of Object.values(s.pages)) {
        expect(() => getNode(sitemap, page), `${s.key} on ${page}`).not.toThrow();
      }
    }
  });
});
