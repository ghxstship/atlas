import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { betaCatalogs } from "../src/beta.generated.ts";
import {
  betaLocales,
  coverage,
  defaultLocale,
  getMessages,
  isBetaLocale,
  isLaunchLocale,
  isLocale,
  launchLocales,
  locales,
  registerBetaCatalog,
  withFallback,
} from "../src/index.ts";
import { loadMessages } from "../src/load.ts";

function keyPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([k, v]) => keyPaths(v, prefix ? `${prefix}.${k}` : k));
}

function lookup(tree: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        typeof node === "object" && node !== null
          ? (node as Record<string, unknown>)[key]
          : undefined,
      tree,
    );
}

describe("message catalogs", () => {
  const source = keyPaths(getMessages(defaultLocale)).sort();

  it.each(launchLocales)("launch locale %s carries exactly the source keys", (locale) => {
    expect(keyPaths(getMessages(locale)).sort()).toEqual(source);
  });

  it.each(launchLocales)("launch locale %s has no empty messages", (locale) => {
    const flat = JSON.stringify(getMessages(locale));
    expect(flat).not.toMatch(/:""/);
  });

  it("recognizes the launch and Beta locales of Section 15 and nothing else", () => {
    expect([...launchLocales]).toEqual(["en-US", "es-US"]);
    expect([...betaLocales]).toEqual(["fr-FR", "de-DE", "it-IT", "pt-BR", "ja-JP"]);
    expect([...locales]).toEqual([...launchLocales, ...betaLocales]);
    expect(isLocale("es-US")).toBe(true);
    expect(isLocale("fr-FR")).toBe(true);
    expect(isLocale("en-GB")).toBe(false);
    expect(isLaunchLocale("ja-JP")).toBe(false);
    expect(isBetaLocale("ja-JP")).toBe(true);
    expect(isBetaLocale("es-US")).toBe(false);
  });
});

describe("Beta catalogs (ADR 0053)", () => {
  const source = keyPaths(getMessages(defaultLocale)).sort();

  it.each(betaLocales)("%s loads with every source key and no raw keys", async (locale) => {
    const messages = await loadMessages(locale);
    expect(keyPaths(messages).sort()).toEqual(source);
    expect(JSON.stringify(messages)).not.toMatch(/:""/);
    // getMessages serves the loaded catalog from then on.
    expect(getMessages(locale)).toBe(messages);
    // Whatever the pipeline has written so far, an untranslated key reads en-US, never its key.
    for (const path of ["shell.chrome.language", "settings.save", "shell.chrome.theme"]) {
      const value = lookup(messages, path);
      expect(typeof value, `${locale} ${path}`).toBe("string");
      expect(value).not.toBe(path);
    }
  });

  it.each(betaLocales)("%s has a generated module the loader imports on demand", (locale) => {
    expect(typeof betaCatalogs[locale]).toBe("function");
    const files = readdirSync(new URL("../src/beta", import.meta.url));
    expect(files).toContain(`${locale}.generated.ts`);
  });

  it("falls back to en-US key by key, keeps translations and drops unknown keys", () => {
    const en = {
      shell: { greeting: "Hello", nested: { save: "Save", cancel: "Cancel" } },
      ui: { ok: "OK" },
    };
    const partial = {
      shell: { greeting: "Bonjour", nested: { save: "", cancel: 3 }, extra: "Hors source" },
      unknown: { a: "b" },
    };
    expect(withFallback(en, partial)).toEqual({
      shell: { greeting: "Bonjour", nested: { save: "Save", cancel: "Cancel" } },
      ui: { ok: "OK" },
    });
    expect(withFallback(en, undefined)).toEqual(en);
    expect(coverage(en, partial)).toEqual({ translated: 1, total: 4 });
  });

  it("serves a registered partial catalog merged over en-US", () => {
    const merged = registerBetaCatalog("it-IT", { shell: { chrome: { language: "Lingua" } } });
    expect(lookup(merged, "shell.chrome.language")).toBe("Lingua");
    expect(lookup(merged, "shell.chrome.theme")).toBe(
      lookup(getMessages("en-US"), "shell.chrome.theme"),
    );
    expect(keyPaths(merged).sort()).toEqual(source);
    expect(getMessages("it-IT")).toBe(merged);
  });
});
