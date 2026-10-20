import { readFileSync } from "node:fs";
import { getMessages } from "@xos/i18n";
import format from "icu-minify/format";
import { describe, expect, it } from "vitest";
import { messagesFor, uiMessages } from "@/i18n/request";

/**
 * Gateway hands next-intl precompiled messages and resolves `use-intl/format-message` to the
 * format-only runtime, as Atlas does (ADR 0027), so the ICU parser stays out of every page. Atlas's
 * test/precompile.test.ts checks that every message of every catalog formats the same compiled.
 */
describe("Gateway messages", () => {
  it("reach next-intl compiled, and format as their source does", () => {
    const results = messagesFor("en-US").gateway.explore.results as unknown;
    expect(typeof results).not.toBe("string");
    const formatters = {
      getDateTimeFormat: (...args: ConstructorParameters<typeof Intl.DateTimeFormat>) =>
        new Intl.DateTimeFormat(...args),
      getNumberFormat: (...args: ConstructorParameters<typeof Intl.NumberFormat>) =>
        new Intl.NumberFormat(...args),
      getPluralRules: (...args: ConstructorParameters<typeof Intl.PluralRules>) =>
        new Intl.PluralRules(...args),
    };
    const text = (n: number) =>
      String(format(results as never, "en-US", { n } as never, { formatters }));
    expect([text(0), text(1), text(3)]).toEqual([
      "No opportunities",
      "1 opportunity",
      "3 opportunities",
    ]);
    // Pseudo-locales are compiled from their own source too.
    expect(typeof (messagesFor("en-XA").gateway.explore.results as unknown)).not.toBe("string");
  });

  it("keep @xos/ui copy as source text, which the design system fills itself", () => {
    const ui = uiMessages("es-US") ?? {};
    const sourceUi = getMessages("es-US").ui as Record<string, unknown>;
    const [key] = Object.keys(ui);
    expect(key).toBeDefined();
    const source = (key ?? "")
      .split(".")
      .reduce<unknown>((node, k) => (node as Record<string, unknown>)[k], sourceUi);
    expect(ui[key ?? ""]).toBe(source);
  });

  it("resolve the format-only runtime in the build", () => {
    const config = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
    expect(config).toContain('"use-intl/format-message": formatOnlyAlias');
    expect(config).toContain("use-intl/format-message/format-only");
  });
});
