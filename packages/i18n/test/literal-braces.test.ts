import { describe, expect, it } from "vitest";
import { getMessages, locales } from "../src/index.ts";
import { flatten, icuArguments, type Catalog } from "./icu.ts";

/**
 * Finding A59-007: ICU reads `{PROJECT}` as an argument, so a help line meant to show the literal
 * token rendered "Use undefined and undefined". Arguments are camelCase or snake_case names that call
 * sites pass; a token written in capitals (a format token, a code) is literal text and must be
 * quoted with apostrophes ('{PROJECT}'). Every message of every catalog is checked.
 */

const ARGUMENT = /^[a-z][A-Za-z0-9_]*$/;

describe("literal braces in messages", () => {
  it.each(locales)("%s quotes literal tokens instead of reading them as arguments", (locale) => {
    const offenders: string[] = [];
    for (const [namespace, catalog] of Object.entries(getMessages(locale))) {
      for (const [key, message] of flatten(catalog as Catalog)) {
        for (const argument of icuArguments(message)) {
          const name = argument.slice(0, argument.indexOf(":"));
          if (!ARGUMENT.test(name)) offenders.push(`${namespace}.${key}: {${name}}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it.each(locales)("%s shows the record key tokens on Numbering", (locale) => {
    const help = (getMessages(locale) as unknown as Record<string, Catalog>)["settings"];
    const flat = flatten(help as Catalog);
    const message = [...flat].find(([key]) => key.endsWith("recordKeyFormat.help"))?.[1] ?? "";
    expect(icuArguments(message)).toEqual([]);
    expect(message).toContain("'{PROJECT}'");
  });
});
