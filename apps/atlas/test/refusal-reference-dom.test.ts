// @vitest-environment jsdom
/**
 * Refusal alerts printed the bare rule code under every message, such as org_name_mismatch or org_deletion_legal_hold
 * (crawl 4.9). A refusal the catalog explains shows no code; one it has no sentence for shows the code labelled as a
 * reference for support.
 */
import { getMessages } from "@xos/i18n";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { createElement as h } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
}));

const { Feedback } = await import("@/components/platform/kit");
const messages = getMessages("en-US") as { platform: { refusals: Record<string, string> } };

afterEach(cleanup);

const show = (rule: string) =>
  render(
    h(NextIntlClientProvider, {
      locale: "en-US",
      messages,
      timeZone: "America/New_York",
      children: h(Feedback, { state: { rule } }),
    }),
  );

describe("refusal feedback", () => {
  it("shows no bare code for a refusal the catalog explains", () => {
    const known = Object.keys(messages.platform.refusals).find((k) => k !== "other") ?? "";
    const { container } = show(known);
    expect(screen.getByText(messages.platform.refusals[known] ?? "")).toBeTruthy();
    expect(container.textContent).not.toContain(known);
  });

  it("labels the code of a refusal it has no sentence for", () => {
    const { container } = show("brand_new_rule");
    expect(container.textContent).toContain("Reference for support: brand_new_rule");
  });
});
