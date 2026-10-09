import { describe, expect, it } from "vitest";
import enXA from "../messages/pseudo/en-XA.json" with { type: "json" };
import arXB from "../messages/pseudo/ar-XB.json" with { type: "json" };
import { getMessages, isLocale, locales } from "../src/index.ts";
import { flatten, icuArguments, type Catalog } from "./icu.ts";

const source = flatten(getMessages("en-US"));
const ui = new Map([...source].filter(([key]) => key.startsWith("ui.")));
const pseudo: Record<string, Catalog> = { "en-XA": enXA, "ar-XB": arXB };

describe("ICU messages", () => {
  it("reads argument names and kinds through plurals, selects and tags", () => {
    const message =
      "{count, plural, one {# file from {org}} other {# files}} {when, date, short} {role, select, lead {<b>{name}</b>} other {}}";
    expect(icuArguments(message)).toEqual([
      "b:tag",
      "count:plural",
      "name:argument",
      "org:argument",
      "role:select",
      "when:date",
    ]);
    expect(() => icuArguments("{broken")).toThrow();
  });

  it("merges the 319 design system messages under the ui namespace", () => {
    expect(ui.size).toBe(319);
    expect(Object.keys(getMessages("en-US"))).toEqual(["shell", "nav", "ui"]);
  });

  it.each(locales)("%s: every message parses as ICU", (locale) => {
    for (const [key, message] of flatten(getMessages(locale))) {
      expect(() => icuArguments(message), `${locale} ${key}`).not.toThrow();
    }
  });

  it("es-US uses the same ICU arguments as en-US for every key", () => {
    const es = flatten(getMessages("es-US"));
    const mismatched = [...source].filter(
      ([key, message]) => icuArguments(message).join() !== icuArguments(es.get(key) ?? "").join(),
    );
    expect(mismatched.map(([key]) => key)).toEqual([]);
    expect([...source].some(([, message]) => icuArguments(message).length > 0)).toBe(true);
  });
});

describe.each(Object.keys(pseudo))("pseudo-locale %s", (locale) => {
  const catalog = flatten(pseudo[locale] ?? {});

  it("covers exactly the ui keys of en-US and nothing outside ui", () => {
    expect([...catalog.keys()].sort()).toEqual([...ui.keys()].sort());
  });

  it("keeps every ICU argument of en-US", () => {
    for (const [key, message] of ui) {
      expect(icuArguments(catalog.get(key) ?? ""), key).toEqual(icuArguments(message));
    }
  });

  it("changes every message so untranslated strings stand out", () => {
    const unchanged = [...ui].filter(([key, message]) => catalog.get(key) === message);
    expect(unchanged.map(([key]) => key)).toEqual([]);
  });

  it("is not a shipped locale", () => {
    expect(isLocale(locale)).toBe(false);
  });
});
