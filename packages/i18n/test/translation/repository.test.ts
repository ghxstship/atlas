/**
 * The offline translation check on the repository's own catalogs, help articles and guides (it runs
 * in pnpm verify through this package's tests), and the masking of every real en-US string.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatFindings, runCheck } from "../../src/translation/check.ts";
import { loadSetup } from "../../src/translation/config.ts";
import { compareStructure, planIcu } from "../../src/translation/icu.ts";
import { planMarkdown } from "../../src/translation/markdown.ts";
import { compileProtector } from "../../src/translation/protect.ts";
import { code, findTestReferences } from "../../src/translation/report.ts";
import { readUnits } from "../../src/translation/surfaces.ts";
import { makeRepo } from "./fixture.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const setup = loadSetup(root);

describe("translation check (offline)", () => {
  const result = runCheck(setup);

  it("finds every key, ICU structure, protected word and terminology rule intact in every target", () => {
    expect(result.errors, formatFindings(result)).toEqual([]);
  });

  it("reports stale strings as warnings (ADR 0037), listing them for the next translate run", () => {
    if (result.warnings.length > 0) console.warn(formatFindings({ ...result, errors: [] }));
    expect(setup.config.check.stale).toBe("warning");
  });

  it("covers the catalogs, the help articles, the docs guides and the canon labels of every target", () => {
    expect(setup.config.surfaces.map((s) => s.id)).toEqual(["catalogs", "help", "guides", "canon"]);
    for (const { locale } of setup.config.targets) {
      const total = Object.values(result.statuses[locale] ?? {}).reduce((a, b) => a + b, 0);
      expect(total).toBeGreaterThan(12000);
    }
  });
});

describe("masking every en-US string", () => {
  const protector = compileProtector(setup.terms.doNotTranslate);
  const units = setup.config.surfaces.flatMap((s) => readUnits(root, s, "en-US", "es-US"));

  // About 17,800 strings, each planned and reassembled: a third of a second on a laptop, but
  // seconds on a CI runner busy with every package's tests, hence the longer timeout.
  it("round-trips every message and article through a transport that returns its input", () => {
    const broken: string[] = [];
    for (const u of units) {
      const protect = (text: string) => protector.ranges(text, u.id);
      const plan =
        u.format === "icu"
          ? planIcu(u.source, protect)
          : planMarkdown(u.source, protect, { frontMatter: u.surface.frontMatter ?? [] });
      const out = plan.assemble(plan.segments.map((s) => s.html));
      // Prettier realigns table padding after a write, so cell padding does not count.
      const same =
        u.format === "icu"
          ? out === u.source && compareStructure(u.source, out, "es-US").length === 0
          : out.replace(/ +\|/g, " |") === u.source.replace(/ +\|/g, " |");
      if (!same) broken.push(u.id);
    }
    expect(broken).toEqual([]);
    expect(units.length).toBeGreaterThan(12000);
  }, 20_000);
});

describe("report helpers", () => {
  it("wraps any text in a code span", () => {
    expect(code("Hola {name}")).toBe("`Hola {name}`");
    expect(code("use `xos`")).toBe("`` use `xos` ``");
    expect(code(undefined)).toBe("(missing)");
    expect(code("")).toBe("(empty)");
  });

  it("finds the tests that quote a string a run changed", () => {
    const repo = makeRepo({
      "packages/email/test/email.test.ts":
        'expect(subject).toBe("Aprobación solicitada: Rigging rental");\n',
      "apps/atlas/e2e/home.spec.ts": 'await expect(page.getByText("Sí")).toBeVisible();\n',
      "apps/atlas/lib/copy.ts": 'export const s = "Aprobación solicitada: x";\n',
    });
    const refs = findTestReferences(repo.root, [
      { id: "email.kinds.approval.requested.subject", before: "Aprobación solicitada: {title}" },
      { id: "short", before: "Sí" },
      { id: "word", before: "Aprobación" },
      { id: "help/x.md", before: "Aprobación solicitada: x" },
    ]);
    expect([...refs].sort()).toEqual([
      ["email.kinds.approval.requested.subject", ["packages/email/test/email.test.ts"]],
      ["short", ["apps/atlas/e2e/home.spec.ts"]],
    ]);
  });
});
