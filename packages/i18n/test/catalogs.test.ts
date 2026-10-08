import { describe, expect, it } from "vitest";
import { defaultLocale, getMessages, isLocale, locales } from "../src/index.ts";

function keyPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([k, v]) => keyPaths(v, prefix ? `${prefix}.${k}` : k));
}

describe("message catalogs", () => {
  const source = keyPaths(getMessages(defaultLocale)).sort();

  it.each(locales)("%s carries exactly the source keys", (locale) => {
    expect(keyPaths(getMessages(locale)).sort()).toEqual(source);
  });

  it.each(locales)("%s has no empty messages", (locale) => {
    const flat = JSON.stringify(getMessages(locale));
    expect(flat).not.toMatch(/:""/);
  });

  it("recognizes only shipped locales", () => {
    expect(isLocale("es-US")).toBe(true);
    expect(isLocale("en-GB")).toBe(false);
  });
});
