import { getNode } from "@xos/ia";
import enConsole from "@xos/i18n/messages/en-US/console.json" with { type: "json" };
import esConsole from "@xos/i18n/messages/es-US/console.json" with { type: "json" };
import enNav from "@xos/i18n/messages/en-US/nav.json" with { type: "json" };
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sitemap } from "../ia/sitemap.generated";
import { englishOnly, inSection, sectionPaths, territoryName } from "../lib/localized";

/** What the 4.9 surface crawl found in the operator console's Spanish copy, headings and targets. */
const page = (path: string) => readFileSync(join(process.cwd(), "app/(console)", path), "utf8");

describe("console in Spanish", () => {
  it("names a territory in the console's language", () => {
    const territory = { nameEn: "the United States", nameEs: "Estados Unidos" };
    expect(territoryName(territory, "es-US")).toBe("Estados Unidos");
    expect(territoryName(territory, "en-US")).toBe("the United States");
    expect(territoryName({ nameEn: "Brazil", nameEs: " " }, "es-US")).toBe("Brazil");
    expect(page("territories/page.tsx")).toContain("territoryName(territory, locale)");
  });

  it("marks the English-only flag descriptions on a console in another language", () => {
    expect(englishOnly("es-US")).toBe("en");
    expect(englishOnly("en-US")).toBeUndefined();
    expect(page("flags/page.tsx")).toContain("lang={lang}");
    expect(esConsole.flags.descriptionsInEnglish).not.toBe(enConsole.flags.descriptionsInEnglish);
  });

  it("calls the signed-in Administrator a person, not a department", () => {
    expect(esConsole.roles.Administrator).toBe("Administrador");
  });

  it("fits every ground and action in the 280 px select", () => {
    for (const catalog of [enConsole, esConsole]) {
      for (const group of [catalog.grounds, catalog.ratingDisputeGrounds, catalog.actions]) {
        for (const text of Object.values(group)) expect(text.length, text).toBeLessThanOrEqual(36);
      }
    }
  });
});

describe("console headings and targets", () => {
  it("titles each top-bar page as the top bar names it", () => {
    const nav = enNav.console as Record<string, string>;
    const titles = enConsole as unknown as Record<string, { title?: string }>;
    for (const id of sitemap.chrome?.["topBar"] ?? []) {
      const key = getNode(sitemap, id).node.label.replace(/^nav\.console\./, "");
      const label = nav[key];
      const title = titles[key]?.title;
      // Where the words are the same, so is the casing.
      if (label && title && label.toLowerCase() === title.toLowerCase()) {
        expect(title, key).toBe(label);
      }
    }
    expect(enConsole.flags.title).toBe(nav["flags"]);
    expect(enConsole.ratingDisputes.title).toBe(nav["ratingDisputes"]);
  });

  it("names the dispute on its record and leads back to the queue", () => {
    const record = page("rating-disputes/[disputeId]/page.tsx");
    expect(record).toContain('t("ratingDisputes.detailTitle", { person })');
    expect(record).toContain('t("ratingDisputes.back")');
    expect(enConsole.ratingDisputes.detailTitle).toContain("{person}");
    expect(esConsole.ratingDisputes.detailTitle).toContain("{person}");
  });

  it("marks Moderation current on a rating dispute, which lives below it", () => {
    const moderation = sectionPaths(getNode(sitemap, "moderation").node);
    expect(moderation).toEqual(expect.arrayContaining(["/moderation", "/rating-disputes"]));
    expect(inSection("/rating-disputes/0193a1b2-0000-7000-8000-000000000000", moderation)).toBe(
      true,
    );
    expect(inSection("/reported-content", moderation)).toBe(false);
    expect(inSection("/tenants", sectionPaths(getNode(sitemap, "tenants").node))).toBe(true);
  });

  it("gives a territory's Edit link the 24 px target", () => {
    expect(page("territories/page.tsx")).toMatch(
      /min-h-target-fine[^"]*text-accent-text underline/,
    );
  });
});
