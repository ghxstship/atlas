import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONTENT_FILTER_RULE,
  contentFilterNormalForm,
  FOLD_FROM,
  FOLD_TO,
  holdsObjectionableLanguage,
  objectionableTerm,
} from "../src/content-filter.ts";
import { OBJECTIONABLE_TERMS } from "../src/objectionable-terms.ts";
import {
  objectionableTermsLoad,
  readObjectionableTermsLoad,
} from "../src/objectionable-terms-sql.ts";

const migrationsDir = fileURLToPath(new URL("../../../supabase/migrations/", import.meta.url));
const migrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const read = (name: string): string => readFileSync(join(migrationsDir, name), "utf8");

describe("the objectionable language filter (App Store Review Guideline 1.2)", () => {
  it("folds case, accents and stand-in digits and symbols, and separates words with one space", () => {
    expect(contentFilterNormalForm("Hello, World!")).toBe(" hello world ");
    expect(contentFilterNormalForm("  Maricón ")).toBe(" maricon ");
    expect(contentFilterNormalForm("N1GG3R")).toBe(" nigger ");
    expect(contentFilterNormalForm("$p1c")).toBe(" spic ");
    expect(contentFilterNormalForm("f@g_bot")).toBe(" fag bot ");
    expect(contentFilterNormalForm("")).toBe("  ");
    expect(Array.from(FOLD_FROM)).toHaveLength(Array.from(FOLD_TO).length);
  });

  it("finds a listed term as whole words, with a plural ending", () => {
    expect(objectionableTerm("You are a faggot")).toBe("faggot");
    expect(objectionableTerm("those F4GS again")).toBe("fag");
    expect(objectionableTerm("Sieg   Heil!")).toBe("sieg heil");
    expect(objectionableTerm("son unos maricones")).toBe("maricon");
    expect(objectionableTerm("towelheads")).toBe("towelhead");
    expect(holdsObjectionableLanguage(null, "fine", "w3tback")).toBe(true);
  });

  it("leaves words that only contain a term, and empty text, alone", () => {
    for (const fine of [
      "Scunthorpe crew call at 7",
      "Add spice to the catering order",
      "Flame retardant drapes only",
      "Fagan brought the riggers",
      "Pakistan tour dates",
      "Heil is not a word here; Hitler is history",
      "",
      "   ",
    ]) {
      expect(objectionableTerm(fine), fine).toBeNull();
    }
    expect(objectionableTerm(null)).toBeNull();
    expect(objectionableTerm(undefined)).toBeNull();
    expect(holdsObjectionableLanguage("Load-in at noon")).toBe(false);
  });

  it("lets names and phrases through that are also slurs, since the filter refuses with nobody to override it", () => {
    for (const fine of [
      "Kike Ramírez runs the dock",
      "kike-ramirez",
      "Dick Van Dyke tribute night",
      "Spic and Span cleaning crew",
      "Retard the ignition timing",
      "Paki Kahananui on follow spot",
      "Wipe the gook off the lens",
      "Un mayate en la carpa",
      "Marica Novak, stagehand",
    ]) {
      expect(objectionableTerm(fine), fine).toBeNull();
    }
  });

  it("checks against another list, and an empty list finds nothing", () => {
    expect(objectionableTerm("a new slur", [{ term: "new slur", language: "en" }])).toBe(
      "new slur",
    );
    expect(objectionableTerm("faggot", [])).toBeNull();
  });

  it("names the refusal the database raises", () => {
    expect(CONTENT_FILTER_RULE).toBe("content_objectionable");
  });

  it("keeps every term in its normal form, once", () => {
    const terms = OBJECTIONABLE_TERMS.map((t) => t.term);
    for (const term of terms) expect(contentFilterNormalForm(term)).toBe(` ${term} `);
    expect(new Set(terms).size).toBe(terms.length);
  });

  it("reads back the statement it writes", () => {
    const sql = `-- a migration\n${objectionableTermsLoad(OBJECTIONABLE_TERMS)}`;
    expect(readObjectionableTermsLoad(sql)).toEqual(OBJECTIONABLE_TERMS);
    expect(readObjectionableTermsLoad("select 1;")).toBeNull();
    expect(
      readObjectionableTermsLoad("select private.load_objectionable_terms($terms$["),
    ).toBeNull();
    expect(
      readObjectionableTermsLoad(
        "select private.load_objectionable_terms($terms${}$terms$::jsonb);",
      ),
    ).toBeNull();
  });

  it("the newest migration that loads the terms loads this list", () => {
    const loads = migrations.filter((f) => readObjectionableTermsLoad(read(f)) !== null);
    expect(loads[0]).toBe("6195_objectionable_language_filter.sql");
    const newest = loads.at(-1);
    expect(newest && readObjectionableTermsLoad(read(newest))).toEqual(OBJECTIONABLE_TERMS);
  });

  it("folds the same characters as the database", () => {
    const sql = read("6195_objectionable_language_filter.sql");
    expect(sql).toContain(`'${FOLD_FROM}',\n    '${FOLD_TO}'`);
  });
});
