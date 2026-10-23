import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { flattenRoutes, isNodeVisible } from "@xos/ia";
import { pageSettings } from "../lib/settings/registry";
import { membershipConditions, PERSONAL_TOKENS_SETTING } from "../lib/shell/membership";
import { sitemap } from "../ia/sitemap.generated";

/**
 * Settings surfaces (A86, RRR-131): the A65-004 regression guard. `SettingsSectionPage` shows a section's
 * registered settings and the panels modules contribute; with neither it renders only an empty state. Every
 * routed settings and personal settings page that renders through it must have one or the other, so no section
 * ships empty again. The contributor files are read as text (each `{ node: "...", order, Panel }` entry), the
 * same files the generated index imports.
 */

const appDir = fileURLToPath(new URL("../app/", import.meta.url));
const contributionsDir = fileURLToPath(
  new URL("../components/settings/contributions/", import.meta.url),
);

/**
 * Sections whose panel another work package builds; each names its owner. An entry fails here once its section is
 * no longer empty, so the list only shrinks.
 */
const PENDING: Readonly<Record<string, string>> = {};

function contributedNodes(): Set<string> {
  const nodes = new Set<string>();
  for (const file of readdirSync(contributionsDir)) {
    if (!/^[a-z][a-z0-9-]*\.tsx$/.test(file)) continue;
    const source = readFileSync(`${contributionsDir}${file}`, "utf8");
    for (const m of source.matchAll(
      /\{\s*node:\s*"([^"]+)",\s*order:\s*-?\d+,\s*Panel:\s*\w+\s*\}/g,
    )) {
      nodes.add(m[1] as string);
    }
  }
  return nodes;
}

/** The page file of a route: `/{org}/settings/usage` to `app/[org]/settings/usage/page.tsx`. */
function pageFile(route: string): string {
  return `${appDir}${route.replace(/^\//, "").replaceAll(/\{([a-zA-Z]+)\}/g, "[$1]")}/page.tsx`;
}

/** Settings nodes whose page renders through SettingsSectionPage, with the node id it passes. */
function sectionPages(): { id: string; node: string }[] {
  return flattenRoutes(sitemap)
    .filter((r) => r.id.startsWith("settings.") || r.id.startsWith("me."))
    .flatMap((r) => {
      const file = pageFile(r.route);
      if (!existsSync(file)) return [];
      const source = readFileSync(file, "utf8");
      const node = /<SettingsSectionPage\s+node="([^"]+)"/.exec(source)?.[1];
      return node ? [{ id: r.id, node }] : [];
    });
}

describe("no settings section renders only its empty state (A65-004)", () => {
  const contributed = contributedNodes();
  const pages = sectionPages();

  it("finds the section pages and the contributed panels", () => {
    // 42 org sections and 15 personal ones exist; a few render their own page (Members, Billing and Plan).
    expect(pages.length).toBeGreaterThan(40);
    expect(contributed.has("settings.notifications")).toBe(true);
  });

  it("gives every section registered settings or a contributed panel", () => {
    const empty = pages
      .filter(({ id, node }) => {
        expect(node, `${id} passes its own node`).toBe(id);
        const group = node.startsWith("me.") ? "personal" : "org";
        return pageSettings(node, group).length === 0 && !contributed.has(node);
      })
      .map(({ id }) => id)
      .filter((id) => !(id in PENDING));
    expect(empty, "sections that would render only an empty state").toEqual([]);
  });

  it("keeps the pending list to sections that are still empty", () => {
    for (const id of Object.keys(PENDING)) {
      const group = id.startsWith("me.") ? "personal" : "org";
      expect(
        pageSettings(id, group).length === 0 && !contributed.has(id),
        `${id} has a surface now; remove it from PENDING`,
      ).toBe(true);
    }
  });

  it("names only nodes in the sitemap", () => {
    const ids = new Set(flattenRoutes(sitemap).map((r) => r.id));
    for (const node of contributed) expect(ids.has(node), node).toBe(true);
  });
});

describe("developer.personal_tokens decides whether Personal settings, Developer exists", () => {
  it("names the registered setting", () => {
    expect(PERSONAL_TOKENS_SETTING).toBe("developer.personal_tokens");
  });

  it("adds the org-allows-personal-tokens condition only while the org allows tokens", () => {
    const off = membershipConditions({ desktop: true, partner: false, personalTokens: false });
    const on = membershipConditions({ desktop: true, partner: false, personalTokens: true });
    expect(off).toEqual(["desktop"]);
    expect(on).toEqual(["desktop", "org-allows-personal-tokens"]);
    const nav = (conditions: typeof on) => ({ role: "member" as const, conditions });
    expect(isNodeVisible(sitemap, "me.developer", nav(off))).toBe(false);
    expect(isNodeVisible(sitemap, "me.developer", nav(on))).toBe(true);
    expect(membershipConditions({ desktop: false, partner: true, personalTokens: false })).toEqual([
      "partner-org",
    ]);
  });
});
