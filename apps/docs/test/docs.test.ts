/** Content, links, copy and the API reference model of the docs site. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveHref } from "../lib/links.ts";
import { guides, helpArticles, searchPages, whatsNew } from "../lib/content.ts";
import { LOCALES, negotiate, translator } from "../lib/i18n.ts";
import {
  linksIn,
  parseBody,
  parseDocument,
  parseInline,
  slugify,
  textOf,
} from "../lib/markdown.ts";
import { DOCUMENT_FILE, kebab, loadReference, pythonLiteral } from "../lib/openapi.ts";

describe("markdown", () => {
  it("parses headings, paragraphs, lists, notes, code and tables", () => {
    const body = parseBody(
      [
        "## First",
        "Some **bold** and `code` with [a link](guide:writes).",
        "continued line",
        "",
        "- one",
        "- two",
        "1. first",
        "> A note",
        "",
        "```ts",
        "const a = 1;",
        "```",
        "| A | B |",
        "| --- | --- |",
        "| 1 | 2 |",
        "### First",
        "## First",
      ].join("\n"),
    );
    expect(body.map((b) => b.t)).toEqual([
      "h2",
      "p",
      "ul",
      "ol",
      "note",
      "code",
      "table",
      "h3",
      "h2",
    ]);
    expect(body[1]).toEqual({
      t: "p",
      c: [
        { t: "text", v: "Some " },
        { t: "strong", v: "bold" },
        { t: "text", v: " and " },
        { t: "code", v: "code" },
        { t: "text", v: " with " },
        { t: "link", v: "a link", href: "guide:writes" },
        { t: "text", v: ". continued line" },
      ],
    });
    expect(
      body.filter((b) => b.t === "h2" || b.t === "h3").map((b) => ("id" in b ? b.id : "")),
    ).toEqual(["first", "first-2", "first-3"]);
    expect(linksIn(body)).toEqual(["guide:writes"]);
    expect(textOf(body)).toContain("const a = 1;");
    expect(() => parseBody("```\nopen")).toThrow(/not closed/);
  });

  it("reads frontmatter and slugifies accented headings", () => {
    expect(parseDocument("---\ntitle: T\norder: 2\n---\nBody").meta).toEqual({
      title: "T",
      order: 2,
    });
    expect(parseDocument("No frontmatter").body).toHaveLength(1);
    expect(() => parseDocument("---\n- a\n---\nx")).toThrow(/mapping/);
    expect(slugify("Páginas por cursor")).toBe("paginas-por-cursor");
    expect(parseInline("plain")).toEqual([{ t: "text", v: "plain" }]);
  });

  it("resolves site links", () => {
    expect(resolveHref("help:gates", "es-US")).toEqual({
      href: "/es-US/help/gates",
      external: false,
    });
    expect(resolveHref("guide:cli", "en-US")).toEqual({
      href: "/en-US/guides/cli",
      external: false,
    });
    expect(resolveHref("reference:projects", "en-US")).toEqual({
      href: "/en-US/reference/projects",
      external: false,
    });
    expect(resolveHref("https://supabase.com", "en-US").external).toBe(true);
  });
});

describe("guides", () => {
  it("exist in every locale with the same slugs, sections and order", () => {
    const shape = (locale: (typeof LOCALES)[number]) =>
      guides(locale).map((g) => [g.slug, g.section, g.order]);
    expect(guides("en-US").length).toBeGreaterThanOrEqual(11);
    for (const locale of LOCALES) expect(shape(locale)).toEqual(shape("en-US"));
  });

  it("include the self-hosting guide with the Supabase CLI and Docker Compose", () => {
    const guide = guides("en-US").find((g) => g.slug === "self-hosting");
    expect(textOf(guide?.body ?? [])).toMatch(/supabase db reset/);
    expect(textOf(guide?.body ?? [])).toMatch(/Docker Compose/);
  });

  it("only link to pages that exist", () => {
    const reference = loadReference();
    for (const locale of LOCALES) {
      const guideSlugs = new Set(guides(locale).map((g) => g.slug));
      const helpSlugs = new Set(helpArticles(locale).map((a) => a.slug));
      for (const page of [...guides(locale), ...helpArticles(locale)]) {
        for (const href of linksIn(page.body)) {
          const m = /^(guide|help|reference):(.+)$/.exec(href);
          if (!m) continue;
          const exists =
            m[1] === "guide"
              ? guideSlugs.has(m[2] as string)
              : m[1] === "help"
                ? helpSlugs.has(m[2] as string)
                : reference.resources.some((r) => r.slug === m[2]);
          expect(exists, `${locale}/${page.slug} links to ${href}`).toBe(true);
        }
      }
    }
  });

  it("name only fields the contract has in their filter examples", () => {
    const doc = JSON.parse(readFileSync(DOCUMENT_FILE, "utf8")) as {
      components: { schemas: Record<string, { properties: Record<string, unknown> }> };
    };
    const record = Object.keys(doc.components.schemas["Record"]?.properties ?? {});
    expect(record).toEqual(expect.arrayContaining(["record_state", "due_at", "title"]));
    const po = Object.keys(doc.components.schemas["PurchaseOrder"]?.properties ?? {});
    expect(po).toEqual(expect.arrayContaining(["po_state", "po_number", "currency_code"]));
  });
});

describe("help center", () => {
  it("reads A31's articles in every locale", () => {
    const en = helpArticles("en-US");
    expect(en.length).toBeGreaterThan(20);
    for (const locale of LOCALES)
      expect(helpArticles(locale).map((a) => a.slug)).toEqual(en.map((a) => a.slug));
    expect(en.every((a) => ["guide", "page", "workflow", "glossary"].includes(a.kind))).toBe(true);
  });

  it("searches titles first", () => {
    const results = searchPages(helpArticles("en-US"), "gate", (a) => textOf(a.body));
    expect(results[0]?.title.toLowerCase()).toContain("gate");
    expect(searchPages(helpArticles("en-US"), "  ", () => "")).toEqual([]);
  });

  it("has copy for every What's New entry and article kind", () => {
    for (const locale of LOCALES) {
      const th = translator(locale, "help");
      for (const entry of whatsNew()) {
        expect(th(`whatsNew.${entry.key}.title`)).not.toBe("");
        if (entry.article)
          expect(helpArticles(locale).some((a) => a.slug === entry.article)).toBe(true);
      }
      for (const kind of ["guide", "page", "workflow", "glossary"])
        expect(th(`kinds.${kind}`)).not.toBe("");
    }
  });
});

describe("copy", () => {
  it("translates with variables and refuses missing keys", () => {
    const t = translator("es-US");
    expect(t("reference.operations", { count: 3 })).toBe("3 operaciones");
    expect(t("reference.operations")).toBe("{count} operaciones");
    expect(() => t("nope.nope")).toThrow(/Missing message/);
  });

  it("negotiates the locale from Accept-Language", () => {
    expect(negotiate("es-MX,es;q=0.9,en;q=0.5")).toBe("es-US");
    expect(negotiate("en-GB")).toBe("en-US");
    expect(negotiate("fr-FR, de;q=0")).toBe("en-US");
    expect(negotiate(null)).toBe("en-US");
    expect(negotiate("es-US;q=0.2, en-US;q=0.8")).toBe("en-US");
  });
});

describe("API reference", () => {
  const reference = loadReference();
  const doc = JSON.parse(readFileSync(DOCUMENT_FILE, "utf8")) as {
    info: { version: string };
    paths: Record<string, Record<string, unknown>>;
  };

  it("covers every operation in the OpenAPI document", () => {
    const count = Object.values(doc.paths).reduce((n, item) => n + Object.keys(item).length, 0);
    expect(reference.operationCount).toBe(count);
    expect(reference.version).toBe(doc.info.version);
    expect(new Set(reference.resources.map((r) => r.slug)).size).toBe(reference.resources.length);
    expect(loadReference()).toBe(reference);
  });

  it("describes a list, a create and an update with fields, examples and samples", () => {
    const projects = reference.resources.find((r) => r.name === "projects");
    const list = projects?.operations.find((o) => o.verb === "list");
    expect(list).toMatchObject({ paged: true, method: "GET", path: "/projects" });
    expect(list?.response?.name).toBe("Project");
    expect(list?.queryParams.map((p) => p.name)).toEqual(
      expect.arrayContaining(["limit", "cursor", "filter"]),
    );
    expect(list?.samples.typescript).toContain("xos.projects.listAll(");
    expect(list?.samples.python).toContain("xos.projects.list_all(");
    const create = projects?.operations.find((o) => o.verb === "create");
    expect(create?.idempotent).toBe(true);
    expect(create?.body?.fields.find((f) => f.name === "name")?.required).toBe(true);
    expect(create?.samples.curl).toContain("Idempotency-Key");
    expect(create?.samples.cli).toContain("xos projects create --data");
    const update = projects?.operations.find((o) => o.verb === "update");
    expect(update?.ifMatch).toBe(true);
    expect(update?.samples.python).toContain("if_match=etag");
    expect(update?.samples.cli).toContain("--if-match auto");
    expect(update?.errorStatuses).toContain(412);
  });

  it("formats names and literals for samples", () => {
    expect(kebab("purchaseOrders")).toBe("purchase-orders");
    expect(pythonLiteral({ a: [true, false, null, 1, "x"] })).toBe(
      '{"a": [True, False, None, 1, "x"]}',
    );
  });
});
