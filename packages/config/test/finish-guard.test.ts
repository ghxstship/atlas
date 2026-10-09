import { describe, expect, it } from "vitest";
import { formatFinding, isProductionPath, isScannable, scanText } from "../src/finish-guard.ts";

// Banned tokens are assembled at runtime so this file passes the guard it tests.
const MARKER = "TO" + "DO";
const FILLER = "Lor" + "em";
const WORD = "place" + "holder";
const MOCK = "mo" + "ck";
const DASH = String.fromCharCode(0x2014);

const rules = (file: string, text: string) => scanText(file, text).map((f) => f.rule);

describe("scanText", () => {
  it("flags unfinished-work markers", () => {
    expect(rules("apps/atlas/a.ts", `// ${MARKER}: finish`)).toEqual(["marker"]);
    expect(rules("apps/atlas/a.ts", `// FIX${"ME"}`)).toEqual(["marker"]);
  });

  it("ignores lowercase words that only contain a marker", () => {
    expect(rules("apps/atlas/a.ts", "const todos = [];")).toEqual([]);
  });

  it("flags filler text in any case", () => {
    expect(rules("apps/atlas/a.md", `${FILLER} dolor sit`)).toEqual(["filler-text"]);
  });

  it("allows the word as a form attribute, prop or CSS pseudo-element", () => {
    expect(rules("apps/atlas/a.tsx", `<input ${WORD}="Search" />`)).toEqual([]);
    expect(rules("apps/atlas/a.ts", `const p = { ${WORD}: label };`)).toEqual([]);
    expect(rules("apps/atlas/a.ts", `interface P { ${WORD}?: string }`)).toEqual([]);
    expect(rules("apps/atlas/a.css", `input::${WORD} { color: red; }`)).toEqual([]);
  });

  it("flags the word anywhere else", () => {
    expect(rules("apps/atlas/a.md", `This is ${WORD} copy.`)).toEqual(["filler-word"]);
    expect(rules("apps/atlas/a.tsx", `<input ${WORD}="x" /> ${WORD} text`)).toEqual([
      "filler-word",
    ]);
  });

  it("flags mock data only in production paths", () => {
    expect(rules("apps/atlas/data.ts", `const ${MOCK}Rows = [];`)).toEqual([
      "test-double-in-production",
    ]);
    expect(rules("apps/atlas/data.test.ts", `const ${MOCK}Rows = [];`)).toEqual([]);
    expect(rules("packages/testing/src/x.ts", `vi.${MOCK}()`)).toEqual([]);
  });

  it("flags em dashes", () => {
    expect(rules("supabase/seed/a.sql", `'Stage ${DASH} Main'`)).toEqual(["em-dash"]);
  });

  it("reports one-based line numbers and a trimmed excerpt", () => {
    const findings = scanText("x.md", `ok\n   ${FILLER} here   `);
    expect(findings).toMatchObject([{ line: 2, excerpt: `${FILLER} here` }]);
    expect(findings.map(formatFinding)).toEqual([`x.md:2 [filler-text] ${FILLER} here`]);
  });
});

describe("isScannable", () => {
  it("scans source, seed and copy formats", () => {
    expect(isScannable("apps/atlas/app/page.tsx")).toBe(true);
    expect(isScannable("supabase/migrations/0001_foundation.sql")).toBe(true);
    expect(isScannable("packages/i18n/messages/en-US.json")).toBe(true);
  });

  it("skips binaries, canon inputs, design exports and third-party verbatim text", () => {
    expect(isScannable("apps/atlas/public/logo.png")).toBe(false);
    expect(isScannable("canon/source/XOS_4.0_Item_Catalog.csv")).toBe(false);
    expect(isScannable("LICENSE")).toBe(false);
    expect(isScannable("CODE_OF_CONDUCT.md")).toBe(false);
    expect(isScannable("docs/spec/XOS_4.0_Build_Prompt.md")).toBe(false);
    expect(isScannable("design/xos-screens/AtlasHome.dc.html")).toBe(false);
    expect(isScannable("pnpm-lock.yaml")).toBe(false);
  });
});

describe("isProductionPath", () => {
  it("treats test, fixture and story paths as non-production", () => {
    expect(isProductionPath("apps/atlas/e2e/journey.ts")).toBe(false);
    expect(isProductionPath("packages/ui/src/button.stories.tsx")).toBe(false);
    expect(isProductionPath("packages/ui/src/button.tsx")).toBe(true);
  });
});
