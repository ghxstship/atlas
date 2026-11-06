/**
 * B10: the registrations queue offers deciding only to someone who can decide. Member and viewer hold
 * opportunities.application.read org-wide but not opportunities.pool.write, so they read the rows and get no picker and no
 * buttons: app.decide_crew_registrations would refuse them, and reloading never helps. Rendered with the real catalog.
 */
import type { RegistrationRow } from "@xos/data/registration";
import { getMessages } from "@xos/i18n";
import { NextIntlClientProvider } from "next-intl";
import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/[org]/opportunities/registration-pages/actions", () => ({
  decideRegistrationsAction: async () => ({}),
}));

const { RegistrationQueue } = await import("@/components/opportunities/registration-queue");

const messages = getMessages("en-US");
type IntlProps = ComponentProps<typeof NextIntlClientProvider>;
const intl: Omit<IntlProps, "children"> = { locale: "en-US", timeZone: "UTC", messages };

function render(element: ReactNode): string {
  return renderToStaticMarkup(createElement(NextIntlClientProvider, intl as IntlProps, element));
}

const ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  personName: "Ana Ruiz",
  pageTitle: "Summer crew",
  state: "Submitted",
  submittedAt: "2026-11-01T12:00:00Z",
  confirmedMinimumAge: 18,
  profileShareId: null,
  answers: [{ prompt: "Which roles do you work?", answer: "Rigger" }],
} as unknown as RegistrationRow;

describe("RegistrationQueue", () => {
  it("offers the picker and both decisions to someone who can decide", () => {
    const html = render(
      createElement(RegistrationQueue, { org: "demo", rows: [ROW], canDecide: true }),
    );
    expect(html).toContain("<form");
    expect(html).toContain('name="approve"');
    expect(html).toContain("Ana Ruiz");
  });

  it("shows a reader the rows with no form, picker or button", () => {
    const html = render(
      createElement(RegistrationQueue, { org: "demo", rows: [ROW], canDecide: false }),
    );
    expect(html).toContain("Ana Ruiz");
    expect(html).toContain("Rigger");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<button");
    expect(html).not.toContain('name="approve"');
  });
});
