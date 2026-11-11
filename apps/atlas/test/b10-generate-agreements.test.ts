/**
 * B10: Create posts what was previewed, not the form's current picks. Changing the template or the people after a preview
 * cannot generate documents nobody read. Rendered with the preview's answer in place.
 */
import { getMessages } from "@xos/i18n";
import { NextIntlClientProvider } from "next-intl";
import type * as React from "react";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const PREVIEWED = "22222222-2222-4222-8222-222222222222";
const CURRENT = "33333333-3333-4333-8333-333333333333";
const PERSON = "44444444-4444-4444-8444-444444444444";

const actions = vi.hoisted(() => ({
  previewAgreementBatchAction: async () => ({}),
  createAgreementBatchAction: async () => ({}),
  sendGeneratedBatchAction: async () => ({}),
}));

vi.mock("@/app/[org]/opportunities/agreements-actions", () => actions);
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof React>();
  return {
    ...react,
    useActionState: (action: unknown, initial: unknown) => [
      action === actions.previewAgreementBatchAction
        ? {
            rows: [
              {
                engagementId: PERSON,
                name: "Ana Ruiz",
                title: "Crew agreement",
                body: "You work the show.",
                missing: [],
              },
            ],
            previewed: {
              projectId: "55555555-5555-4555-8555-555555555555",
              templateId: PREVIEWED,
              requirementId: "",
              engagementIds: [PERSON],
            },
            at: 1,
          }
        : initial,
      () => undefined,
      false,
    ],
  };
});

const { GenerateAgreements } = await import("@/components/opportunities/generate-agreements");

type IntlProps = ComponentProps<typeof NextIntlClientProvider>;
const intl: Omit<IntlProps, "children"> = {
  locale: "en-US",
  timeZone: "UTC",
  messages: getMessages("en-US"),
};

describe("GenerateAgreements", () => {
  it("creates what was previewed even after the picks change", () => {
    const html = renderToStaticMarkup(
      createElement(
        NextIntlClientProvider,
        intl as IntlProps,
        createElement(GenerateAgreements, {
          org: "demo",
          projectId: "55555555-5555-4555-8555-555555555555",
          // The form now holds another template and nobody picked: the first option stands for the current pick.
          templates: [{ id: CURRENT, name: "Another", usesRate: false }],
          requirements: [],
          people: [{ engagementId: PERSON, name: "Ana Ruiz", jobTitle: null }],
          canReadRates: true,
        }),
      ),
    );
    const createForm = html.slice(html.lastIndexOf("<form"));
    expect(createForm).toContain(`name="templateId" value="${PREVIEWED}"`);
    expect(createForm).toContain(`name="engagementIds" value="${PERSON}"`);
    expect(createForm).not.toContain(CURRENT);
  });
});
