import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import {
  isDraftVersion,
  LEGAL_HISTORY_ID,
  LegalContents,
  legalDay,
  LegalHistory,
  LegalOutline,
  LegalText,
  legalDocumentLinks,
  legalPlainText,
  legalTextSource,
  legalVersionInEffect,
  legalVersions,
  legalVersionState,
  parseLegalMarkdown,
  stripFrontmatter,
  type LegalHistoryEntry,
  type LegalVersion,
} from "../src/LegalText/index.ts";

afterEach(cleanup);

const hrefFor = (slug: string) => (slug === "missing" ? null : `/legal/${slug}`);
const show = (markdown: string) =>
  render(<LegalText blocks={parseLegalMarkdown(markdown)} hrefFor={hrefFor} />);

describe("stripFrontmatter", () => {
  it("removes the frontmatter and nothing else", () => {
    const body = "# Title\n\n> **Draft.** Not in effect.\n\n---\n\nAfter a rule.\n";
    expect(stripFrontmatter(`---\ntitle: T\nversion: 1.0.0-draft\n---\n\n${body}`)).toBe(body);
    expect(stripFrontmatter(body)).toBe(body);
  });
});

describe("isDraftVersion", () => {
  it("follows the version alone", () => {
    expect(isDraftVersion("1.0.0-draft")).toBe(true);
    expect(isDraftVersion("1.0.0")).toBe(false);
  });
});

describe("parseLegalMarkdown", () => {
  it("gives numbered headings and clauses section anchors, and others their text", () => {
    const blocks = parseLegalMarkdown(
      "# Terms\n\n## 3. Accounts\n\n### 3.1 Roles\n\n3.6 **Agreement.** Text.\n\n## Contact Us\n\n## Contact Us\n",
    );
    expect(blocks.flatMap((b) => ("id" in b && b.id ? [b.id] : []))).toEqual([
      "terms",
      "section-3",
      "section-3-1",
      "section-3-6",
      "contact-us",
      "contact-us-2",
    ]);
  });

  it("links a section of this document, and no other document's", () => {
    show(
      "## 1. One\n\n2.5 Clause.\n\nSee Section 1, Section 2.5 and Section 9. Section 1 of the Agreement. Security Overview, Section 1. Section 2.5 of the DPA.\n",
    );
    expect(screen.getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual([
      "#section-1",
      "#section-2-5",
    ]);
  });

  it("keeps ordered lists' numbers, and joins a list split by blank lines", () => {
    const [list] = parseLegalMarkdown("3. Third\n\n4. Fourth\n\nAfter\n");
    expect(list).toMatchObject({ t: "list", ordered: true, start: 3 });
    expect(list?.t === "list" ? list.items : []).toHaveLength(2);
  });

  it("nests an indented list under its item and returns to the outer list", () => {
    const [list, ...rest] = parseLegalMarkdown("- a\n  - a1\n  - a2\n- b\n\nAfter\n");
    expect(rest).toHaveLength(1);
    const items = list?.t === "list" ? list.items : [];
    expect(items).toHaveLength(2);
    expect(items[0]?.children[0]).toMatchObject({ t: "list", ordered: false });
  });

  it("carries a line directly under an item with that item", () => {
    const [list, ...rest] = parseLegalMarkdown("- first\nmore of it\n");
    expect(rest).toEqual([]);
    expect(legalPlainText(list ? [list] : [])).toContain("first more of it");
  });

  it("does not take a snake_case word for emphasis", () => {
    const [p] = parseLegalMarkdown("the org_owner_at_signup value and _this_\n");
    expect(p?.t === "p" ? p.c : []).toEqual([
      { t: "text", v: "the org_owner_at_signup value and " },
      { t: "em", c: [{ t: "text", v: "this" }] },
    ]);
  });

  it("leaves a pipe in a code span or written \\| inside its cell", () => {
    const [table] = parseLegalMarkdown("| A | B |\n| - | - |\n| `x|y` | c\\|d |\n");
    expect(table?.t === "table" ? table.rows[0]?.length : 0).toBe(2);
    expect(legalPlainText(table ? [table] : [])).toContain("c|d");
  });

  it("names two tables under one heading apart", () => {
    const blocks = parseLegalMarkdown("## Fees\n\n| A |\n| - |\n| 1 |\n\n| A |\n| - |\n| 2 |\n");
    expect(blocks.flatMap((b) => (b.t === "table" ? [b.label] : []))).toEqual(["Fees", "Fees (2)"]);
  });

  it("collects the documents a text points to, however deep", () => {
    const blocks = parseLegalMarkdown(
      "> see /legal/a\n\n- **at /legal/b**\n  - /legal/c\n\n| /legal/d |\n| - |\n| atlas.ghxstship.tech/legal/e. |\n",
    );
    expect(legalDocumentLinks(blocks)).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("LegalText", () => {
  it("renders headings, lists, emphasis and code as real elements", () => {
    show("# Title\n\n## 1. One\n\nHello **bold** and _soft_ and `code`.\n\n- item\n\n1. first\n");
    expect(screen.getByRole("heading", { level: 1, name: "Title" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "1. One" }).id).toBe("section-1");
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("soft").tagName).toBe("EM");
    expect(screen.getByText("code").tagName).toBe("CODE");
    expect(screen.getAllByRole("list")).toHaveLength(2);
  });

  it("marks the text as English and exempt from the pseudo-locale check", () => {
    const { container } = show("# Title\n");
    const root = container.firstElementChild;
    expect(root?.getAttribute("lang")).toBe("en-US");
    expect(root?.hasAttribute("data-pseudo-exempt")).toBe(true);
  });

  it("links documents through hrefFor, email addresses, and written links", () => {
    show(
      "At /legal/contact and atlas.ghxstship.tech/legal/privacy-policy. Write to legal@ghxstship.tech. Not /legal/missing or /legal. Read [the policy](https://example.com/p).\n",
    );
    expect(screen.getByRole("link", { name: "/legal/contact" }).getAttribute("href")).toBe(
      "/legal/contact",
    );
    expect(
      screen
        .getByRole("link", { name: "atlas.ghxstship.tech/legal/privacy-policy" })
        .getAttribute("href"),
    ).toBe("/legal/privacy-policy");
    expect(screen.getByRole("link", { name: "legal@ghxstship.tech" }).getAttribute("href")).toBe(
      "mailto:legal@ghxstship.tech",
    );
    expect(screen.getByRole("link", { name: "the policy" }).getAttribute("href")).toBe(
      "https://example.com/p",
    );
    expect(screen.getAllByRole("link")).toHaveLength(4);
    expect(screen.getByText(/Not \/legal\/missing or \/legal\./)).toBeTruthy();
  });

  it("never turns a script link or inline HTML into markup", () => {
    const { container } = show(
      "[click](javascript:alert(1)) and <img src=x onerror=alert(1)> and `<b>`\n",
    );
    expect(container.querySelector("img, b, script")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("renders a table with column headers in a labeled region a keyboard can reach", () => {
    show("## 2. Fees\n\n| Plan | Fee |\n| --- | --- |\n| Pro | $1 |\n");
    const region = screen.getByRole("region", { name: "2. Fees" });
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(within(region).getAllByRole("columnheader")).toHaveLength(2);
    expect(within(region).getByRole("cell", { name: "Pro" })).toBeTruthy();
  });

  it("starts an ordered list at its own number", () => {
    const { container } = show("5. Fifth\n");
    expect(container.querySelector("ol")?.getAttribute("start")).toBe("5");
  });

  it("renders on the server with no HTML string and no hook", () => {
    const html = renderToStaticMarkup(
      <LegalText blocks={parseLegalMarkdown("# Title\n\nA & B <c>\n")} hrefFor={hrefFor} />,
    );
    expect(html).toContain("A &amp; B &lt;c&gt;");
  });
});

describe("the outline", () => {
  const blocks = parseLegalMarkdown("# T\n\n## 1. A\n\n### 1.1 Sub\n\n## 2. B\n\n## 3. C\n");

  it("links the second-level headings in a named navigation", () => {
    render(<LegalOutline blocks={blocks} label="On this page" />);
    const nav = screen.getByRole("navigation", { name: "On this page" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual(["#section-1", "#section-2", "#section-3"]);
  });

  it("opens in the page's flow with no script, as a disclosure", () => {
    const { container } = render(<LegalContents blocks={blocks} label="On this page" />);
    expect(container.querySelector("details summary")?.textContent).toBe("On this page");
  });

  it("stays away from a short document", () => {
    const short = parseLegalMarkdown("# T\n\n## 1. A\n\n## 2. B\n");
    expect(render(<LegalOutline blocks={short} label="x" />).container.firstChild).toBeNull();
    expect(render(<LegalContents blocks={short} label="x" />).container.firstChild).toBeNull();
  });
});

describe("legalTextSource", () => {
  const first = [{ version: "1.0.0-draft", summary: "First version." }];
  const documents = [
    { slug: "a", file: "a.md", publish: "public", version: "1.0.0-draft", history: first },
    { slug: "b", file: "b.md", publish: "public", version: "1.0.0-draft", history: first },
    { slug: "secret", file: "s.md", publish: "internal", version: "1.0.0-draft", history: first },
  ];
  const read = (file: string) => `---\nversion: 1.0.0-draft\n---\n\n# ${file}\n`;

  it("holds public documents' bodies only, and every public slug", () => {
    const source = legalTextSource("// stamp", documents, read);
    expect(source.startsWith("// stamp\n")).toBe(true);
    expect(source).toContain('"a":"# a.md\\n"');
    expect(source).not.toContain("secret");
    expect(source).not.toContain("version: 1.0.0-draft");
  });

  it("leaves out what the app does not serve, while still naming it", () => {
    const source = legalTextSource("// stamp", documents, read, (slug) => slug === "a");
    expect(source).not.toContain("b.md");
    expect(source).toContain('LEGAL_SLUGS: readonly string[] = ["a","b"]');
  });

  it("carries each served document's versions, a draft with no effective date", () => {
    const source = legalTextSource("// stamp", documents, read, (slug) => slug === "a");
    expect(source).toContain(
      'LEGAL_HISTORY: Readonly<Record<string, readonly LegalVersion[]>> = {"a":[{"version":"1.0.0-draft","effectiveDate":null,"summary":"First version."}]}',
    );
  });
});

describe("legalVersions", () => {
  const doc = (version: string, history: LegalHistoryEntry[]) => ({
    slug: "terms",
    file: "terms.md",
    publish: "public",
    version,
    history,
  });
  const text = (version: string, effective: string) =>
    `---\ntitle: T\nversion: ${version}\neffective_date: ${effective}\n---\n\n# T\n`;

  it("gives a version in effect the day its frontmatter states, newest first", () => {
    const history = [
      { version: "1.1.0", effective_date: "2027-03-01", summary: "Clearer notice terms." },
      { version: "1.0.0", effective_date: "2026-12-01", summary: "First version." },
    ];
    expect(legalVersions(doc("1.1.0", history), text("1.1.0", '"2027-03-01"'))).toEqual([
      { version: "1.1.0", effectiveDate: "2027-03-01", summary: "Clearer notice terms." },
      { version: "1.0.0", effectiveDate: "2026-12-01", summary: "First version." },
    ]);
  });

  it("refuses a final version whose frontmatter states another day, or none", () => {
    const history = [{ version: "1.0.0", effective_date: "2026-12-01", summary: "First." }];
    expect(() => legalVersions(doc("1.0.0", history), text("1.0.0", "2026-12-02"))).toThrow(
      /effective_date: 2026-12-01/,
    );
    expect(() => legalVersions(doc("1.0.0", history), text("1.0.0", "When it is final"))).toThrow(
      /effective_date: 2026-12-01/,
    );
  });

  it("refuses a final version with no real day", () => {
    const history = [{ version: "1.0.0", effective_date: "2026-02-30", summary: "First." }];
    expect(() => legalVersions(doc("1.0.0", history), text("1.0.0", "2026-02-30"))).toThrow(
      /needs an effective_date/,
    );
  });

  it("refuses a history that does not open with the current version or the text's", () => {
    const history = [{ version: "1.0.0-draft", summary: "First." }];
    expect(() => legalVersions(doc("1.1.0-draft", history), text("1.1.0-draft", "x"))).toThrow(
      /open with the current version/,
    );
    expect(() => legalVersions(doc("1.0.0-draft", history), text("1.0.1-draft", "x"))).toThrow(
      /does not state version 1.0.0-draft/,
    );
  });

  it("refuses a dated draft, an older draft, a missing summary and dates out of order", () => {
    const run = (history: LegalHistoryEntry[]) => () =>
      legalVersions(
        doc(history[0]?.version ?? "", history),
        text(history[0]?.version ?? "", "2027-03-01"),
      );
    expect(run([{ version: "1.0.0-draft", effective_date: "2026-12-01", summary: "x" }])).toThrow(
      /cannot have an effective date/,
    );
    expect(
      run([
        { version: "1.1.0-draft", summary: "x" },
        { version: "1.0.0-draft", summary: "y" },
      ]),
    ).toThrow(/only the current version may be a draft/);
    expect(run([{ version: "1.0.0", effective_date: "2027-03-01", summary: " " }])).toThrow(
      /no summary of changes/,
    );
    expect(
      run([
        { version: "1.1.0", effective_date: "2027-03-01", summary: "x" },
        { version: "1.0.0", effective_date: "2027-04-01", summary: "y" },
      ]),
    ).toThrow(/newest first/);
  });

  it("refuses a draft over a final version, whose text the draft would replace on the page", () => {
    const history = [
      { version: "1.1.0-draft", summary: "Clearer notice terms." },
      { version: "1.0.0", effective_date: "2026-12-01", summary: "First version." },
    ];
    expect(() => legalVersions(doc("1.1.0-draft", history), text("1.1.0-draft", "x"))).toThrow(
      /draft 1.1.0-draft would hide final 1.0.0/,
    );
  });
});

describe("legalVersionState", () => {
  const history: LegalVersion[] = [
    { version: "1.1.0", effectiveDate: "2027-03-01", summary: "Clearer notice terms." },
    { version: "1.0.0", effectiveDate: "2026-12-01", summary: "First version." },
  ];

  it("reads the UTC day", () => {
    expect(legalDay(new Date("2027-02-28T23:30:00-05:00"))).toBe("2027-03-01");
  });

  it("calls a final version upcoming before its effective date and in effect from it", () => {
    const [next, first] = history;
    if (!next || !first) throw new Error("history");
    expect(legalVersionState(next, "2027-02-28")).toBe("upcoming");
    expect(legalVersionState(next, "2027-03-01")).toBe("inEffect");
    expect(legalVersionState(first, "2027-02-28")).toBe("inEffect");
    expect(legalVersionState({ ...next, effectiveDate: null }, "2027-03-01")).toBe("draft");
  });

  it("finds the version that stays in effect while a newer one is upcoming", () => {
    expect(legalVersionInEffect(history, "2027-02-28")?.version).toBe("1.0.0");
    expect(legalVersionInEffect(history, "2027-03-01")?.version).toBe("1.1.0");
    expect(legalVersionInEffect(history, "2026-11-30")).toBeUndefined();
  });
});

describe("LegalHistory", () => {
  const history: LegalVersion[] = [
    { version: "1.1.0", effectiveDate: "2027-03-01", summary: "Clearer notice terms." },
    { version: "1.0.0", effectiveDate: "2026-12-01", summary: "First version." },
  ];
  const label = (v: LegalVersion) => `Version ${v.version}: ${v.effectiveDate ?? "draft"}`;

  it("lists every version under a named heading, newest first, with its summary in English", () => {
    render(<LegalHistory history={history} title="Version history" describe={label} />);
    const section = screen.getByRole("region", { name: "Version history" });
    const items = within(section).getAllByRole("listitem");
    expect(items.map((li) => li.firstElementChild?.textContent)).toEqual([
      "Version 1.1.0: 2027-03-01",
      "Version 1.0.0: 2026-12-01",
    ]);
    const summary = within(section).getByText("First version.");
    expect(summary.getAttribute("lang")).toBe("en-US");
    expect(summary.hasAttribute("data-pseudo-exempt")).toBe(true);
  });

  it("keeps its id when the document has a heading of the same name", () => {
    const blocks = parseLegalMarkdown("# T\n\n## Version History\n\nRows.\n");
    const heading = blocks.find((b) => b.t === "heading" && b.level === 2);
    expect(heading && "id" in heading ? heading.id : undefined).toBe(`${LEGAL_HISTORY_ID}-2`);
    render(<LegalHistory history={history} title="Version history" describe={label} />);
    expect(screen.getByRole("region", { name: "Version history" }).id).toBe("");
    expect(document.getElementById(LEGAL_HISTORY_ID)?.textContent).toBe("Version history");
  });

  it("shows nothing when there is no history", () => {
    const empty = render(<LegalHistory history={[]} title="x" describe={label} />);
    expect(empty.container.firstChild).toBeNull();
  });
});
