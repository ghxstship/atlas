import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Outline, outlineLinkClass } from "@/components/markdown.tsx";

/**
 * The outline beside a page (its headings, or a resource's operations) is a column of block links, one per line.
 * Each is at least 24 px tall (WCAG 2.2 SC 2.5.8): the crawl measured them at 19 px on 247 of 278 pages (crawl 4.9).
 */
describe("outline link targets", () => {
  it("gives every outline link the 24 px fine-pointer minimum", () => {
    const html = renderToStaticMarkup(
      createElement(Outline, {
        label: "On this page",
        body: [
          { t: "h2", id: "one", v: "One" },
          { t: "h2", id: "two", v: "Two" },
        ] as Parameters<typeof Outline>[0]["body"],
      }),
    );
    const links = [...html.matchAll(/<a [^>]*class="([^"]+)"/g)].map((m) => m[1]);
    expect(links).toHaveLength(2);
    for (const c of links) expect(c).toContain("min-h-target-fine");
    expect(outlineLinkClass).toMatch(/inline-flex .*min-h-target-fine/);
  });

  it("the API reference outlines use the same links", () => {
    for (const page of [
      "app/[locale]/reference/[resource]/page.tsx",
      "app/[locale]/reference/[resource]/[operation]/page.tsx",
    ]) {
      const source = readFileSync(join(process.cwd(), page), "utf8");
      expect(source, page).toContain("${outlineLinkClass}");
    }
  });
});
