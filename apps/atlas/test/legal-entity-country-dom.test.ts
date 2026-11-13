// @vitest-environment jsdom
/**
 * Legal entity country was a two-character free-text box: typing "Germany" kept "Ge" and saved Georgia, GE
 * (crawl 4.9). It is a picker of real countries by name in the reader's language, and the action accepts only real codes.
 */
import { getMessages } from "@xos/i18n";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { createElement as h } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/[org]/settings/access-control-actions", () => ({
  addLegalEntityAction: vi.fn(),
  addNetworkAction: vi.fn(),
  addProjectRoleAction: vi.fn(),
  removeProjectRoleAction: vi.fn(),
  revokeShareAction: vi.fn(),
  shareProjectAction: vi.fn(),
  blockProfileAction: vi.fn(),
  cancelAccessReviewAction: vi.fn(),
  decideAccessReviewAction: vi.fn(),
  endBreakGlassAction: vi.fn(),
  legalEntityAction: vi.fn(),
  legalEntityAddressAction: vi.fn(),
  openAccessReviewAction: vi.fn(),
  removeNetworkAction: vi.fn(),
  startBreakGlassAction: vi.fn(),
  unblockAction: vi.fn(),
}));
vi.mock("@/components/auth/security/step-up", () => ({ useStepUpForm: () => null }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
}));

const { AddLegalEntityForm } = await import("@/components/settings/access-control-forms");

afterEach(cleanup);

for (const [locale, germany] of [
  ["en-US", "Germany"],
  ["es-US", "Alemania"],
] as const) {
  describe(`the legal entity country in ${locale}`, () => {
    it("is a picker of countries by name", () => {
      render(
        h(NextIntlClientProvider, {
          locale,
          messages: getMessages(locale),
          timeZone: "America/New_York",
          children: h(AddLegalEntityForm, {
            org: "acme",
            months: [{ value: "1", label: "January" }],
            currencies: [{ value: "USD", label: "USD" }],
            defaultMonth: "1",
            defaultCurrency: "USD",
          }),
        }),
      );
      const country = document.getElementById("legal-entity-country");
      expect(country?.tagName).toBe("SELECT");
      const option = screen.getByRole("option", { name: germany }) as HTMLOptionElement;
      expect(option.value).toBe("DE");
      expect(screen.queryByRole("option", { name: "Ge" })).toBeNull();
    });
  });
}
