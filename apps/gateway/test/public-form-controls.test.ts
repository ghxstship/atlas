/**
 * B2 (RRR-226, ADR 0141): gate 27 counts every input, so a multi_choice rendered as a checkbox per choice would pass seven
 * on its own. A public form's first window holds name, email and up to five fields, and stays within the limit however
 * many choices a field has. The honeypot sits in a hidden wrapper the gate does not count.
 */
import { getMessages } from "@xos/i18n";
import type { PublicFormField } from "@xos/data/form-links";
import { NextIntlClientProvider } from "next-intl";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/actions/public-form", () => ({ submitPublicFormAction: vi.fn() }));

const { PublicFormFill } = await import("@/components/outside/public-form");

type IntlProps = ComponentProps<typeof NextIntlClientProvider>;
const intl: Omit<IntlProps, "children"> = {
  locale: "en-US",
  timeZone: "UTC",
  messages: getMessages("en-US"),
};

const field = (key: string, extra: Partial<PublicFormField> = {}): PublicFormField => ({
  key,
  label: key,
  kind: "text",
  required: false,
  choices: null,
  showIf: null,
  ...extra,
});

function render(fields: readonly PublicFormField[]): string {
  return renderToStaticMarkup(
    createElement(
      NextIntlClientProvider,
      intl as IntlProps,
      createElement(PublicFormFill, { token: "t", fields }),
    ),
  );
}

/** Visible controls as gate 27 counts them, leaving out the hidden wrapper's honeypot. */
const controls = (html: string) =>
  (html.replace(/<div hidden="">.*?<\/div>/s, "").match(/<(input|select|textarea)\b/g) ?? []).length;

describe("a public form window's controls", () => {
  it("counts a multi_choice as one control, whatever its number of choices", () => {
    const choices = Array.from({ length: 40 }, (_, i) => `Choice ${i}`);
    const html = render([field("a", { kind: "multi_choice", choices })]);
    expect(html).toContain('role="combobox"');
    expect(html).not.toContain('type="checkbox"');
    // Name, email and the one field.
    expect(controls(html)).toBe(3);
  });

  it("stays within seven with a full first window that includes one", () => {
    const html = render([
      field("a"),
      field("b", { kind: "yes_no" }),
      field("c", { kind: "multi_choice", choices: ["1", "2", "3", "4", "5", "6", "7", "8"] }),
      field("d", { kind: "choice", choices: ["x", "y"] }),
      field("e", { kind: "long_text" }),
      field("f"),
    ]);
    expect(controls(html)).toBe(7);
    expect(html).not.toContain('id="field-f"');
  });
});
