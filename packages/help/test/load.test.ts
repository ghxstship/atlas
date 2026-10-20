import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  helpProblems,
  loadHelpContent,
  parseArticle,
  renderHelpBodies,
  renderHelpGuides,
  renderHelpModule,
  uncoveredNodes,
} from "../src/load";

const root = mkdtempSync(join(tmpdir(), "xos-help-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function write(dir: string, files: Readonly<Record<string, string>>): string {
  for (const [name, text] of Object.entries(files)) {
    const file = join(dir, name);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
  }
  return dir;
}

const md = (title: string, nodes: string, body = "Body.") =>
  `---\ntitle: ${title}\nsummary: About ${title}\nkind: page\nnodes: [${nodes}]\norder: 1\n---\n${body}\n`;

describe("help loader", () => {
  it("reads articles and treats missing tours, tips and What's New as empty", () => {
    const dir = write(join(root, "bare"), {
      "articles/en-US/home.md": md("Home", "home"),
      "articles/es-US/home.md": md("Inicio", "home"),
    });
    const content = loadHelpContent(dir);
    expect(content.articles["en-US"].map((a) => a.slug)).toEqual(["home"]);
    expect(content.articles["es-US"][0]?.title).toBe("Inicio");
    expect(content).toMatchObject({ tours: [], tips: [], whatsNew: [] });
  });

  it("reads tours, tips and What's New, and renders the generated modules", () => {
    const dir = write(join(root, "full"), {
      "articles/en-US/home.md": md("Home", "home", "## Start\n\nSee [more](help:home)."),
      "articles/es-US/home.md": md("Inicio", "home"),
      "tours.yaml": "tours:\n  - key: start\n    nodes: [home]\n    steps:\n      - target: null\n",
      "tips.yaml": "tips:\n  - key: hint\n    nodes: [home]\n    article: home\n",
      "whats-new.yaml": 'entries:\n  - key: launch\n    date: "2026-10-20"\n',
    });
    const content = loadHelpContent(dir);
    expect(content.whatsNew).toEqual([{ key: "launch", date: "2026-10-20", article: null }]);
    const header = ["// generated"];
    const index = renderHelpModule(content, header);
    expect(index).toContain('import type { HelpIndex } from "./model";');
    expect(index).toContain("export const HELP_CONTENT: HelpIndex = ");
    expect(index).not.toContain('"body"');
    expect(renderHelpGuides(content, header, "@xos/help")).toContain(
      'import type { HelpGuides } from "@xos/help";',
    );
    expect(renderHelpBodies(content, header)).toContain('"help:home"');
    expect(helpProblems(content, new Set(["home"]))).toEqual([]);
  });

  it("refuses an article without frontmatter or with unknown fields", () => {
    expect(() => parseArticle("x", "no frontmatter")).toThrow(/frontmatter/);
    expect(() =>
      parseArticle("x", md("X", "home").replace("order: 1", "order: 1\nextra: 2")),
    ).toThrow();
  });

  it("names every problem in a shell's content", () => {
    const dir = write(join(root, "broken"), {
      "articles/en-US/home.md": md("Home", "home", "[gone](help:gone)"),
      "articles/en-US/only-en.md": md("Only", "nowhere.*"),
      "articles/es-US/home.md": md("Inicio", "home, money"),
      "tips.yaml": "tips:\n  - key: hint\n    nodes: [ghost]\n    article: missing\n",
      "whats-new.yaml": 'entries:\n  - key: launch\n    date: "2026-10-20"\n    article: absent\n',
    });
    const problems = helpProblems(loadHelpContent(dir), new Set(["home", "settings.profile"]));
    expect(problems).toEqual([
      "es-US lacks home|page|1|home",
      "es-US lacks only-en|page|1|nowhere.*",
      "en-US lacks home|page|1|home,money",
      "en-US/home: no article help:gone",
      "en-US/only-en: no node nowhere.*",
      "es-US/home: no node money",
      "hint: no node ghost",
      "hint: no article missing",
      "launch: no article absent",
    ]);
  });

  it("lists the nodes without an article of their own", () => {
    const articles = [
      { slug: "general", title: "", summary: "", kind: "guide" as const, nodes: ["*"], order: 0 },
      { slug: "s", title: "", summary: "", kind: "page" as const, nodes: ["settings.*"], order: 0 },
    ];
    expect(uncoveredNodes(articles, ["home", "settings.profile"])).toEqual(["home"]);
  });
});
