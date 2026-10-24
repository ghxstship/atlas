import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  engineVersion,
  glossaryId,
  loadSetup,
  parseCsv,
  parseGlossary,
} from "../../src/translation/config.ts";
import {
  decodeEntry,
  emptyMemory,
  encodeEntry,
  serializeMemory,
  statusOf,
} from "../../src/translation/memory.ts";
import { compileProtector } from "../../src/translation/protect.ts";
import { compileRules, keptDomainTerm } from "../../src/translation/rules.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const setup = loadSetup(root);
const protector = compileProtector(setup.terms.doNotTranslate);
const rules = compileRules(setup.terms);
const words = (text: string, key = "any.key") =>
  protector.ranges(text, key).map((r) => text.slice(r.start, r.end));

describe("language names in the pickers (ADR 0053)", () => {
  it("keeps every picker label in its own language in every target, and only in the pickers", () => {
    const labels: Record<string, string> = {
      "en-US": "English (US)",
      "es-US": "Español (EE. UU.)",
      "fr-FR": "Français",
      "de-DE": "Deutsch",
      "it-IT": "Italiano",
      "pt-BR": "Português (Brasil)",
      "ja-JP": "日本語",
    };
    for (const [locale, label] of Object.entries(labels)) {
      expect(words(label, `shell.chrome.locales.${locale}`)).toEqual([label]);
      expect(words(label, `gateway.shell.locales.${locale}`)).toEqual([label]);
      expect(words(`Show it in ${label}`, "settings.fields.language.help")).toEqual([]);
    }
  });
});

describe("do-not-translate list (translation/terms.json)", () => {
  it("protects product names, canon codes, identifiers, URLs and paths", () => {
    expect(words("Open Atlas, Gateway and Compass with Aurora on XOS")).toEqual([
      "Atlas",
      "Gateway",
      "Compass",
      "Aurora",
      "XOS",
    ]);
    expect(words("Starts with CC-, for example CC-VENUE or NWL-RAD-014.")).toEqual([
      "CC-VENUE",
      "NWL-RAD-014",
    ]);
    expect(words("Choose yes_no or multi_choice for reports.report.export")).toEqual([
      "yes_no",
      "multi_choice",
      "reports.report.export",
    ]);
    expect(words("Go to https://example.com/a. Then /api/v1, not and/or 24/7")).toEqual([
      "https://example.com/a",
      "/api/v1",
    ]);
  });

  it("protects plan names only where they name a plan", () => {
    expect(words("Aurora AI comes with the Core, Pro, Team and Enterprise plans.")).toEqual([
      "Aurora",
      "Core",
      "Pro",
      "Team",
      "Enterprise",
    ]);
    expect(words("Payroll export needs the Team plan. Packs are for Core, Pro and Team.")).toEqual([
      "Team",
      "Core",
      "Pro",
      "Team",
    ]);
    expect(words("Team and Account Roles")).toEqual([]);
    expect(words("Team", "shell.plans.team.name")).toEqual(["Team"]);
    expect(words("Team", "gateway.profile.company.team")).toEqual([]);
    expect(words("Core function", "canonBrowser.departments.coreFunction")).toEqual([]);
    expect(words("The Access plan includes the help center.")).toEqual(["Access"]);
  });

  it("masks example email addresses but lets a person localize them", () => {
    expect(words("Write an email such as name@company.com.")).toEqual(["name@company.com"]);
    expect(protector.required("Write an email such as name@company.com.", "k")).toEqual([]);
    expect(protector.required("Open Atlas on NWL-12", "k")).toEqual(["Atlas", "NWL-12"]);
  });
});

describe("terminology rules", () => {
  it("call a project gate a compuerta in es-US and keep puerta for physical gates and doors", () => {
    expect(
      rules.violations("projects.gates.title", "Gate review", "es-US", "Revisión de la compuerta"),
    ).toEqual([]);
    expect(
      rules.violations("projects.gates.title", "Gate review", "es-US", "Revisión de la puerta"),
    ).toEqual([
      "project-gate: needs /compuerta/",
      "project-gate: must not contain /\\bpuertas?\\b/",
    ]);
    expect(
      rules.violations("logistics.yard.gateTitle", "Gate queue", "es-US", "Cola de la puerta"),
    ).toEqual([]);
    expect(
      rules.violations("logistics.yard.gateTitle", "Gate queue", "es-US", "Cola de la compuerta"),
    ).toEqual(["physical-gate: must not contain /compuerta/"]);
    expect(
      rules.violations("hospitality.doors", "Door list", "es-US", "Lista de compuerta"),
    ).toEqual(["physical-door: must not contain /compuerta/"]);
  });

  it("send physical gates to Google without the glossary", () => {
    expect(rules.usesGlossary("logistics.yard.gateTitle", "Gate queue")).toBe(false);
    expect(rules.usesGlossary("projects.gates.title", "Gate review")).toBe(true);
  });

  it("let review keep a glossary term Google's version drops", () => {
    const g = parseGlossary("en,es-US\nBaseline,Línea base\ngate,compuerta\n");
    expect(keptDomainTerm(g, "en", "es-US", "Baseline", "Línea base", "Base de referencia")).toBe(
      "Línea base",
    );
    expect(
      keptDomainTerm(g, "en", "es-US", "Baseline", "Línea base", "Línea base aprobada"),
    ).toBeNull();
    expect(keptDomainTerm(g, "en", "es-US", "Budget", "Línea base", "Presupuesto")).toBeNull();
  });
});

describe("glossary.csv", () => {
  it("parses quoted fields and the equivalent term set header", () => {
    expect(parseCsv('en,es-US,description\n"a, b",c,"say ""hi"""\r\n')).toEqual([
      ["en", "es-US", "description"],
      ["a, b", "c", 'say "hi"'],
    ]);
    const g = parseGlossary("en,es-US,description\ngate,compuerta,x\n");
    expect(g.languages).toEqual(["en", "es-US"]);
    expect(g.rows).toEqual([{ en: "gate", "es-US": "compuerta", description: "x" }]);
  });

  it("carries a project gate and the product names, and every row has the same columns", () => {
    const rows = setup.glossary.rows;
    expect(rows).toContainEqual(expect.objectContaining({ en: "gate", "es-US": "compuerta" }));
    for (const name of ["XOS", "Atlas", "Gateway", "Compass", "Aurora"]) {
      expect(rows).toContainEqual(expect.objectContaining({ en: name, "es-US": name }));
    }
    const widths = new Set(parseCsv(setup.glossary.csv).map((r) => r.length));
    expect([...widths]).toEqual([setup.glossary.languages.length + 1]);
  });

  it("has a column for every target language; the Beta columns hold only names never translated (ADR 0053)", () => {
    for (const t of setup.config.targets) expect(setup.glossary.languages).toContain(t.google);
    const beta = setup.config.targets.filter((t) => t.partial).map((t) => t.google);
    expect(beta).toEqual(["fr", "de", "it", "pt", "ja"]);
    for (const row of setup.glossary.rows) {
      for (const language of beta) {
        // Nobody hand-writes a Beta translation: a cell is empty, or the English term itself.
        expect([row["en"], ""], `${row["en"]} ${language}`).toContain(row[language]);
      }
    }
  });

  it("names the Google glossary and the cache generation after its content", () => {
    const other = { ...setup, glossary: parseGlossary(`${setup.glossary.csv}vendor,proveedor,\n`) };
    expect(glossaryId(setup)).toMatch(/^xos-glossary-[0-9a-f]{8}$/);
    expect(glossaryId(other)).not.toBe(glossaryId(setup));
    expect(engineVersion(other)).not.toBe(engineVersion(setup));
  });
});

describe("translation memory", () => {
  it("encodes entries with the producer first", () => {
    const entry = { by: "human", source: "0123456789abcdef", locked: true } as const;
    expect(encodeEntry(entry)).toBe("human 0123456789abcdef locked");
    expect(decodeEntry("google 0123456789abcdef")).toEqual({
      by: "google",
      source: "0123456789abcdef",
      locked: false,
    });
    expect(() => decodeEntry("0123456789abcdef google")).toThrow();
  });

  it("tells missing, unreviewed, current, stale, locked and fallback apart", () => {
    const at = (by: "google" | "human" | "fallback", locked = false) => ({
      by,
      source: "aaaaaaaaaaaaaaaa",
      locked,
    });
    expect(statusOf("aaaaaaaaaaaaaaaa", undefined, at("google"))).toBe("missing");
    expect(statusOf("aaaaaaaaaaaaaaaa", "x", undefined)).toBe("unreviewed");
    expect(statusOf("aaaaaaaaaaaaaaaa", "x", at("google"))).toBe("current");
    expect(statusOf("bbbbbbbbbbbbbbbb", "x", at("google"))).toBe("stale");
    expect(statusOf("aaaaaaaaaaaaaaaa", "x", at("human", true))).toBe("locked");
    expect(statusOf("bbbbbbbbbbbbbbbb", "x", at("human", true))).toBe("locked-stale");
    expect(statusOf("aaaaaaaaaaaaaaaa", "x", at("fallback"))).toBe("stale");
  });

  it("serializes sorted, so reruns give the same file", () => {
    const m = emptyMemory("es-US");
    m.entries.set("b.key", { by: "google", source: "1111111111111111", locked: false });
    m.entries.set("a.key", { by: "human", source: "2222222222222222", locked: true });
    m.segments.set("abcd1234:3333333333333333", "Hola");
    const text = serializeMemory(m);
    expect(text.indexOf('"a.key"')).toBeLessThan(text.indexOf('"b.key"'));
    expect(JSON.parse(text)).toMatchObject({
      locale: "es-US",
      entries: { "a.key": "human 2222222222222222 locked", "b.key": "google 1111111111111111" },
      segments: { "abcd1234:3333333333333333": "Hola" },
    });
  });
});
