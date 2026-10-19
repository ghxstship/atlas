import { describe, expect, it } from "vitest";
import { getMessages } from "@xos/i18n";
import {
  localeDirection,
  negotiateLocale,
  parseAcceptLanguage,
  selectableLocales,
  formattingLocale,
} from "../i18n/negotiate";
import { isPseudoLocale, pseudoCatalog, pseudoMessage, transformMessage } from "../i18n/pseudo";

describe("locale negotiation", () => {
  it("orders Accept-Language by quality", () => {
    expect(parseAcceptLanguage("fr;q=0.2, es-MX;q=0.9, en")).toEqual(["en", "es-MX", "fr"]);
    expect(parseAcceptLanguage("de;q=0, ;q=1")).toEqual([]);
    expect(parseAcceptLanguage(undefined)).toEqual([]);
  });

  it("prefers the cookie, then the browser, then en-US", () => {
    expect(negotiateLocale({ cookie: "es-US", acceptLanguage: "en", production: true })).toBe(
      "es-US",
    );
    expect(negotiateLocale({ acceptLanguage: "es-MX,en;q=0.5", production: true })).toBe("es-US");
    expect(negotiateLocale({ acceptLanguage: "es", production: true })).toBe("es-US");
    expect(negotiateLocale({ cookie: "fr-FR", acceptLanguage: "ja", production: true })).toBe(
      "en-US",
    );
  });

  it("accepts pseudo-locales in development only", () => {
    expect(negotiateLocale({ cookie: "en-XA", production: false })).toBe("en-XA");
    expect(negotiateLocale({ cookie: "en-XA", production: true })).toBe("en-US");
    expect(selectableLocales(true)).toEqual(["en-US", "es-US"]);
    expect(selectableLocales(false)).toEqual(["en-US", "es-US", "en-XA", "ar-XB"]);
  });

  it("knows direction and formatting locale", () => {
    expect(localeDirection("ar-XB")).toBe("rtl");
    expect(localeDirection("es-US")).toBe("ltr");
    expect(formattingLocale("en-XA")).toBe("en-US");
    expect(formattingLocale("es-US")).toBe("es-US");
  });
});

describe("pseudo-locales", () => {
  it("keeps ICU arguments, plural keywords, # and tags", () => {
    const message = "{count, plural, one {# file from {org}} other {# files}} <b>{name}</b> done";
    const out = transformMessage(message, (t) => t.toUpperCase());
    expect(out).toBe("{count, plural, one {# FILE FROM {org}} other {# FILES}} <b>{name}</b> DONE");
  });

  it("accents and pads en-XA, and mirrors ar-XB", () => {
    const xa = pseudoMessage("Save {name}", "en-XA");
    expect(xa.startsWith("[Šàṽé {name}")).toBe(true);
    expect(xa.endsWith("·]")).toBe(true);
    const xb = pseudoMessage("Save", "ar-XB");
    expect(xb).toBe("‮Šàṽé‬");
    expect(isPseudoLocale("en-XA")).toBe(true);
    expect(isPseudoLocale("en-US")).toBe(false);
  });

  it("covers every key of the source catalog and changes every message", () => {
    const source = getMessages("en-US");
    const pseudo = pseudoCatalog(source, "en-XA");
    const flat = (o: object, p = ""): [string, string][] =>
      Object.entries(o).flatMap(([k, v]) =>
        typeof v === "string" ? [[`${p}${k}`, v] as [string, string]] : flat(v, `${p}${k}.`),
      );
    const a = flat(source);
    const b = new Map(flat(pseudo));
    expect(b.size).toBe(a.length);
    expect(a.filter(([k, v]) => b.get(k) === v)).toEqual([]);
  });
});

describe("Inbox notification kinds", () => {
  // The Inbox shows a kind's label when it has no fuller copy; it must never fall back to the key.
  it("labels every notification kind the email catalog knows, in every shipped locale", () => {
    const kindsOf = (tree: Record<string, Record<string, unknown>>) =>
      Object.entries(tree)
        .flatMap(([group, kinds]) => Object.keys(kinds).map((k) => `${group}.${k}`))
        .sort();
    for (const locale of ["en-US", "es-US"] as const) {
      const messages = getMessages(locale) as unknown as {
        email: { kinds: Record<string, Record<string, unknown>> };
        platform: { inbox: { kinds: Record<string, Record<string, string>> } };
      };
      expect(kindsOf(messages.platform.inbox.kinds)).toEqual(kindsOf(messages.email.kinds));
    }
  });
});
