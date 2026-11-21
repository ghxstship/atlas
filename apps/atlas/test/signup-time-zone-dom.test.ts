// @vitest-environment jsdom
/**
 * A new US org started on UTC, so in the evening Legal dated a record a day ahead of Members (crawl 4.9). The org form
 * sends the creator's browser zone, and the action sets it as the org's locale.time_zone when it is a real zone.
 */
import { getMessages } from "@xos/i18n";
import { cleanup, render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { createElement as h } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signupTimeZone } from "@/lib/auth/time-zone";

vi.mock("@/app/auth/actions", () => ({
  acceptInvitation: vi.fn(),
  answerAgeQuestion: vi.fn(),
  closeUnderAgeAccount: vi.fn(),
  createOrganizationAction: vi.fn(),
  signInWithEmail: vi.fn(),
  signUpWithEmail: vi.fn(),
}));

const { OrganizationForm } = await import("@/components/auth/organization-form");

afterEach(cleanup);

describe("signupTimeZone", () => {
  it("keeps a real zone and drops UTC, junk and non-strings", () => {
    expect(signupTimeZone("America/New_York")).toBe("America/New_York");
    expect(signupTimeZone("UTC")).toBeNull();
    expect(signupTimeZone("Mars/Olympus")).toBeNull();
    expect(signupTimeZone("")).toBeNull();
    expect(signupTimeZone(null)).toBeNull();
  });
});

describe("the organization form", () => {
  it("sends the browser's time zone", () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const { container } = render(
      h(NextIntlClientProvider, {
        locale: "en-US",
        messages: getMessages("en-US"),
        timeZone: "America/New_York",
        children: h(OrganizationForm, {
          terms: { href: "/legal/terms", title: "Terms" },
          dpa: { href: "/legal/dpa", title: "DPA" },
          countries: [{ value: "US", label: "United States" }],
        }),
      }),
    );
    const input = container.querySelector<HTMLInputElement>('input[name="orgTimeZone"]');
    expect(input?.value).toBe(zone);
  });

  it("sends the plan chosen before signing up only when the page passed one (issue 115)", () => {
    const form = (plan?: string) =>
      render(
        h(NextIntlClientProvider, {
          locale: "en-US",
          messages: getMessages("en-US"),
          timeZone: "America/New_York",
          children: h(OrganizationForm, {
            terms: { href: "/legal/terms", title: "Terms" },
            dpa: { href: "/legal/dpa", title: "DPA" },
            countries: [{ value: "US", label: "United States" }],
            ...(plan === undefined ? {} : { plan }),
          }),
        }),
      ).container.querySelector<HTMLInputElement>('input[name="plan"]');
    expect(form()).toBeNull();
    const sent = form("core");
    expect(sent?.type).toBe("hidden");
    expect(sent?.value).toBe("core");
  });
});
