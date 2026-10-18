import { parse, TYPE, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";
import { getMessages } from "@xos/i18n";
import format from "icu-minify/format";
import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";
import { precompileMessages } from "../i18n/precompile";
import { pseudoCatalog } from "../i18n/pseudo";

/**
 * Atlas hands next-intl precompiled messages and resolves `use-intl/format-message` to the
 * format-only runtime (ADR 0027, A24-009). This checks that every message of every catalog Atlas
 * serves formats exactly as intl-messageformat (next-intl's runtime parser) formats its source.
 */

type Tree = { readonly [key: string]: string | Tree };

function leaves(tree: Tree, prefix = ""): [string, string][] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "string"
      ? [[`${prefix}${key}`, value] as [string, string]]
      : leaves(value, `${prefix}${key}.`),
  );
}

/** The arguments a message reads, with the kind of value each takes. */
function argumentsOf(
  elements: readonly MessageFormatElement[],
  out = new Map<string, string>(),
): Map<string, string> {
  for (const el of elements) {
    if (el.type === TYPE.argument) out.set(el.value, out.get(el.value) ?? "text");
    if (el.type === TYPE.number) out.set(el.value, "number");
    if (el.type === TYPE.date || el.type === TYPE.time) out.set(el.value, "date");
    if (el.type === TYPE.plural) {
      out.set(el.value, "number");
      for (const option of Object.values(el.options)) argumentsOf(option.value, out);
    }
    if (el.type === TYPE.select) {
      out.set(el.value, `select:${Object.keys(el.options).find((k) => k !== "other") ?? "other"}`);
      for (const option of Object.values(el.options)) argumentsOf(option.value, out);
    }
    if (el.type === TYPE.tag) {
      out.set(el.value, "tag");
      argumentsOf(el.children, out);
    }
  }
  return out;
}

const tag = (name: string) => (chunks: unknown[]) => `<${name}>${chunks.join("")}</${name}>`;
const when = new Date(Date.UTC(2026, 0, 2, 15, 4));
const formatters = {
  getDateTimeFormat: (...args: ConstructorParameters<typeof Intl.DateTimeFormat>) =>
    new Intl.DateTimeFormat(...args),
  getNumberFormat: (...args: ConstructorParameters<typeof Intl.NumberFormat>) =>
    new Intl.NumberFormat(...args),
  getPluralRules: (...args: ConstructorParameters<typeof Intl.PluralRules>) =>
    new Intl.PluralRules(...args),
};
const utc = (formats: Record<string, Intl.DateTimeFormatOptions>) =>
  Object.fromEntries(Object.entries(formats).map(([k, v]) => [k, { timeZone: "UTC", ...v }]));
const mfFormats = {
  date: utc(IntlMessageFormat.formats.date as Record<string, Intl.DateTimeFormatOptions>),
  time: utc(IntlMessageFormat.formats.time as Record<string, Intl.DateTimeFormatOptions>),
};

const text = (value: unknown) => (Array.isArray(value) ? value.join("") : String(value));

const catalogs: [string, Tree][] = [
  ["en-US", getMessages("en-US") as unknown as Tree],
  ["es-US", getMessages("es-US") as unknown as Tree],
  ["en-XA", pseudoCatalog(getMessages("en-US"), "en-XA") as unknown as Tree],
  ["ar-XB", pseudoCatalog(getMessages("en-US"), "ar-XB") as unknown as Tree],
];

describe("precompiled messages", () => {
  it("hold only plain objects and arrays, which React passes to the client provider", () => {
    const odd: string[] = [];
    const walk = (value: unknown, path: string) => {
      if (typeof value !== "object" || value === null) return;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== Array.prototype) odd.push(path);
      for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
    };
    walk(precompileMessages(getMessages("en-US")), "en-US");
    expect(odd).toEqual([]);
  });

  for (const [locale, catalog] of catalogs) {
    it(`format the same as their source in ${locale}`, () => {
      const compiled = precompileMessages(catalog) as unknown as Record<string, unknown>;
      const mismatches: string[] = [];
      let checked = 0;
      for (const [key, source] of leaves(catalog)) {
        const message = key
          .split(".")
          .reduce<unknown>((node, k) => (node as Record<string, unknown>)[k], compiled);
        const args = argumentsOf(parse(source));
        if ([...args.values()].includes("date")) {
          // The format-only runtime reads named date and time styles from next-intl's `formats`,
          // which Atlas does not set, so only email copy (formatted by @xos/email with
          // intl-messageformat; the Inbox reads email kinds without dates) may use them.
          if (!key.startsWith("email.")) mismatches.push(`${key}: date or time argument`);
          continue;
        }
        for (const n of [0, 1, 3]) {
          const values: Record<string, unknown> = {};
          for (const [name, kind] of args) {
            values[name] =
              kind === "number"
                ? n
                : kind === "date"
                  ? when
                  : kind === "tag"
                    ? tag(name)
                    : kind.startsWith("select:")
                      ? n === 1
                        ? kind.slice("select:".length)
                        : "zz-other"
                      : `v${n}`;
          }
          const expected = text(
            new IntlMessageFormat(source, locale, mfFormats, { formatters }).format(
              values as never,
            ),
          );
          const actual = text(
            format(message as never, locale, values as never, { formatters, timeZone: "UTC" }),
          );
          checked += 1;
          if (actual !== expected) mismatches.push(`${key}: ${expected} != ${actual}`);
        }
      }
      expect(checked).toBeGreaterThan(1000);
      expect(mismatches).toEqual([]);
    });
  }
});
