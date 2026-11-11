import { parse, TYPE, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";
import { getMessages } from "@xos/i18n";
import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";
import { precompileMessages } from "../i18n/precompile";
import { emailCopy } from "../lib/inbox/email-copy";

/**
 * Crawl 4.9: shift and transfer items in the Inbox read "starting 11/13/2026 at 11/13/2026", because the format-only
 * runtime has no named date and time styles. The Inbox's email translator gives each style the options
 * intl-messageformat gives it, so every email message with a date, time or number style reads in the Inbox as its
 * email does (@xos/email formats the same source with intl-messageformat).
 */

type Tree = { readonly [key: string]: string | Tree };

function leaves(tree: Tree, prefix = ""): [string, string][] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "string"
      ? [[`${prefix}${key}`, value] as [string, string]]
      : leaves(value, `${prefix}${key}.`),
  );
}

/** Each argument a message reads and the kind of value it takes; styled marks a named date, time or number style. */
function argumentsOf(
  elements: readonly MessageFormatElement[],
  out: { args: Map<string, string>; styled: boolean } = { args: new Map(), styled: false },
) {
  for (const el of elements) {
    if (el.type === TYPE.argument) out.args.set(el.value, out.args.get(el.value) ?? "text");
    if (el.type === TYPE.date || el.type === TYPE.time) {
      out.args.set(el.value, "date");
      if (typeof el.style === "string") out.styled = true;
    }
    if (el.type === TYPE.number) {
      out.args.set(el.value, "number");
      if (typeof el.style === "string") out.styled = true;
    }
    if (el.type === TYPE.plural) {
      out.args.set(el.value, "number");
      for (const o of Object.values(el.options)) argumentsOf(o.value, out);
    }
    if (el.type === TYPE.select) {
      out.args.set(el.value, `select:${Object.keys(el.options).find((k) => k !== "other") ?? ""}`);
      for (const o of Object.values(el.options)) argumentsOf(o.value, out);
    }
    if (el.type === TYPE.tag) argumentsOf(el.children, out);
  }
  return out;
}

const when = new Date(Date.UTC(2026, 10, 13, 0, 0));
const utcFormatters = {
  getDateTimeFormat: (locale?: string | string[], options?: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, { ...options, timeZone: "America/New_York" }),
  getNumberFormat: (locale?: string | string[], options?: Intl.NumberFormatOptions) =>
    new Intl.NumberFormat(locale, options),
  getPluralRules: (locale?: string | string[], options?: Intl.PluralRulesOptions) =>
    new Intl.PluralRules(locale, options),
};

describe("Inbox email copy (crawl 4.9)", () => {
  it("prints a new shift's date and its time, not the date twice", () => {
    const en = emailCopy(
      precompileMessages(getMessages("en-US")).email,
      "en-US",
      "America/New_York",
    );
    expect(en("kinds.shift.assigned.body", { title: "Load In", startsAt: when })).toBe(
      "You are scheduled for Load In starting Thursday, November 12, 2026 at 7:00 PM.",
    );
    const es = emailCopy(
      precompileMessages(getMessages("es-US")).email,
      "es-US",
      "America/New_York",
    );
    const body = es("kinds.shift.assigned.body", { title: "Montaje", startsAt: when }) ?? "";
    expect(body).toContain("jueves, 12 de noviembre de 2026");
    expect(body).toMatch(/7:00\s?p\.\s?m\./);
  });

  it("returns null for a key the namespace does not hold, or values it cannot format", () => {
    const en = emailCopy(precompileMessages(getMessages("en-US")).email, "en-US", "UTC");
    expect(en("kinds.nothing.here")).toBeNull();
    expect(en("kinds.shift.assigned.body", { title: "Load In" })).toBeNull();
  });

  for (const locale of ["en-US", "es-US"] as const) {
    it(`formats every styled email message in ${locale} as intl-messageformat does`, () => {
      const source = getMessages(locale).email as unknown as Tree;
      const copy = emailCopy(
        precompileMessages(getMessages(locale)).email,
        locale,
        "America/New_York",
      );
      const mismatches: string[] = [];
      let checked = 0;
      for (const [key, message] of leaves(source)) {
        const { args, styled } = argumentsOf(parse(message));
        // Rich text needs tag handlers, which the Inbox's plain text never passes.
        if (!styled || /<\w+>/.test(message)) continue;
        const values: Record<string, string | number | Date> = {};
        for (const [name, kind] of args) {
          values[name] =
            kind === "number"
              ? 3
              : kind === "date"
                ? when
                : kind.startsWith("select:")
                  ? kind.slice("select:".length)
                  : `v-${name}`;
        }
        const expected = String(
          new IntlMessageFormat(message, locale, undefined, { formatters: utcFormatters }).format(
            values as never,
          ),
        );
        checked += 1;
        const actual = copy(key, values);
        if (actual !== expected) mismatches.push(`${key}: ${expected} != ${String(actual)}`);
      }
      expect(checked).toBeGreaterThan(5);
      expect(mismatches).toEqual([]);
    });
  }
});
