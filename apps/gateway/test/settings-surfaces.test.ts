import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { flattenRoutes, isNodeVisible } from "@xos/ia";
import { sitemap } from "../ia/sitemap.generated";
import { personalSettings } from "../lib/settings";
import { navContext } from "../lib/shell/standing";

/**
 * Gateway settings surfaces (A86, RRR-131): the A65-004 regression guard for Gateway. Every settings section in
 * the Gateway sitemap renders content: a section of its own in components/settings/sections.tsx, or registered
 * personal settings through the default registry section. A section that only pointed somewhere else (the old
 * NoteSection empty state) cannot come back.
 */

const sections = readFileSync(
  fileURLToPath(new URL("../components/settings/sections.tsx", import.meta.url)),
  "utf8",
);

describe("no Gateway settings section renders only an empty state (A65-004)", () => {
  // Sections render through SettingsSection; the company index only redirects to its first section.
  const nodes = flattenRoutes(sitemap)
    .filter((r) => r.id.startsWith("settings."))
    .filter((r) => {
      const page = fileURLToPath(new URL(`../app/(shell)${r.route}/page.tsx`, import.meta.url));
      return existsSync(page) && readFileSync(page, "utf8").includes("<SettingsSection");
    })
    .map((r) => r.id);

  it("finds the personal and company sections", () => {
    expect(nodes.length).toBeGreaterThan(20);
  });

  it("gives every section its own content or registered settings", () => {
    const empty = nodes.filter(
      (id) => !sections.includes(`case "${id}":`) && personalSettings(id).length === 0,
    );
    expect(empty, "sections with nothing to show").toEqual([]);
  });

  it("has no section that only points elsewhere", () => {
    expect(sections).not.toMatch(/function NoteSection|<NoteSection/);
  });
});

describe("Settings, Developer follows the orgs that allow personal tokens (A86)", () => {
  const base = {
    standing: "individual",
    companyAccount: false,
    platformDomain: true,
    desktop: true,
  } as const;

  it("appears only when an org the person belongs to allows them", () => {
    expect(isNodeVisible(sitemap, "settings.developer", navContext(base))).toBe(false);
    expect(
      isNodeVisible(sitemap, "settings.developer", navContext({ ...base, personalTokens: true })),
    ).toBe(true);
  });
});
