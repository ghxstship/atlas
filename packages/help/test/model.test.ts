import { describe, expect, it } from "vitest";
import {
  articlesForNode,
  bodyText,
  coversNode,
  forNode,
  helpLocale,
  isSpecificTo,
  parseBody,
  parseInline,
  searchArticles,
  type Article,
} from "../src/model";

const article = (slug: string, nodes: string[], order: number): Article => ({
  slug,
  title: slug,
  summary: `About ${slug}`,
  kind: "page",
  nodes,
  order,
  body: [{ t: "ul", items: [[{ t: "text", v: "zebra" }]] }],
});

describe("help model", () => {
  it("parses the Markdown subset", () => {
    expect(
      parseBody(
        "## Head\n\nOne **two** `three`\nfour [five](help:x).\n\n- a\n- b\n\n1. c\n### Sub\ntext",
      ),
    ).toEqual([
      { t: "h2", v: "Head" },
      {
        t: "p",
        c: [
          { t: "text", v: "One " },
          { t: "strong", v: "two" },
          { t: "text", v: " " },
          { t: "code", v: "three" },
          { t: "text", v: " four " },
          { t: "link", v: "five", href: "help:x" },
          { t: "text", v: "." },
        ],
      },
      { t: "ul", items: [[{ t: "text", v: "a" }], [{ t: "text", v: "b" }]] },
      { t: "ol", items: [[{ t: "text", v: "c" }]] },
      { t: "h3", v: "Sub" },
      { t: "p", c: [{ t: "text", v: "text" }] },
    ]);
    expect(parseBody("intro\n- item\nafter")).toEqual([
      { t: "p", c: [{ t: "text", v: "intro" }] },
      { t: "ul", items: [[{ t: "text", v: "item" }]] },
      { t: "p", c: [{ t: "text", v: "after" }] },
    ]);
    expect(parseBody("- a\n1. b")).toEqual([
      { t: "ul", items: [[{ t: "text", v: "a" }]] },
      { t: "ol", items: [[{ t: "text", v: "b" }]] },
    ]);
    expect(parseInline("plain")).toEqual([{ t: "text", v: "plain" }]);
  });

  it("reads the plain text of a body", () => {
    expect(bodyText(parseBody("## A\n\nB **c**\n\n- d"))).toBe("A B  c d");
  });

  it("matches node patterns", () => {
    expect(coversNode("*", "home")).toBe(true);
    expect(coversNode("settings.*", "settings.company.notifications")).toBe(true);
    expect(coversNode("settings.*", "settings")).toBe(false);
    expect(coversNode("home", "home")).toBe(true);
    expect(coversNode("home", "homes")).toBe(false);
    expect(isSpecificTo({ nodes: ["*"] }, "home")).toBe(false);
    expect(isSpecificTo({ nodes: ["*", "home"] }, "home")).toBe(true);
  });

  it("orders page articles before general ones and searches", () => {
    const list = [
      article("general", ["*"], 1),
      article("crew", ["crew.*"], 5),
      article("shifts", ["crew.shifts"], 2),
    ];
    expect(articlesForNode(list, "crew.shifts").map((x) => x.slug)).toEqual([
      "shifts",
      "crew",
      "general",
    ]);
    expect(articlesForNode(list, null).map((x) => x.slug)).toEqual(["general"]);
    expect(searchArticles(list, "crew").map((x) => x.slug)).toEqual(["crew"]);
    expect(searchArticles(list, "zebra")).toHaveLength(3);
    expect(searchArticles(list, "zebra", () => undefined)).toHaveLength(0);
    expect(searchArticles(list, " ")).toEqual([]);
    expect(forNode([{ nodes: ["crew.*"] }], "crew.swaps")).toHaveLength(1);
    expect(forNode([{ nodes: ["crew.*"] }], null)).toHaveLength(0);
  });

  it("falls back to en-US for locales without help", () => {
    expect(helpLocale("es-US")).toBe("es-US");
    expect(helpLocale("en-XA")).toBe("en-US");
  });
});
