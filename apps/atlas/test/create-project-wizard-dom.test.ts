// @vitest-environment jsdom
/**
 * B14 (ADR 0153): changing the event type after picking a past project takes the wizard off the Copy step. The form then
 * posts the start the wizard shows, not the radio left behind, and a refusal on a field no step holds still shows.
 */
import { getMessages } from "@xos/i18n";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { createElement as h } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const eventType = (id: string, name: string) => ({
  id,
  name,
  description: null,
  intakeGuidance: null,
  fields: [],
  templates: [],
  scales: [],
  audiences: [],
});

vi.mock("@/lib/projects/intake", () => ({
  loadIntakeOptionsAction: async () => ({
    eventTypes: [eventType("a", "Festival"), eventType("b", "Concert")],
    templates: [],
    pastProjects: [{ id: "p1", key: "OLD", name: "Old Show" }],
    hasProjectFields: false,
    hasRequiredProjectFields: false,
  }),
  previewIntakeCopyAction: async () => ({ ok: true, data: [] }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
}));

const { CreateProjectWizard } = await import("@/components/projects/create-project-wizard");

const tree = (state: Record<string, unknown>) =>
  h(NextIntlClientProvider, {
    locale: "en-US",
    messages: getMessages("en-US"),
    timeZone: "America/New_York",
    children: h(CreateProjectWizard, {
      org: "acme",
      options: {
        jurisdictions: [],
        tiers: [],
        regions: [],
        venues: [],
        timeZones: ["UTC"],
        currencies: ["USD"],
        defaultTimeZone: "UTC",
      },
      state: state as never,
      action: () => undefined,
      pending: false,
      onCancel: () => undefined,
    }),
  });

describe("the staged intake's start (B14)", () => {
  afterEach(cleanup);

  it("posts the start the wizard shows after the event type changes", async () => {
    const user = userEvent.setup();
    const view = render(tree({}));
    await user.click(await screen.findByRole("radio", { name: /Festival/ }));
    await user.click(await screen.findByRole("radio", { name: /A past project/ }));
    await user.click(screen.getByRole("radio", { name: /Concert/ }));
    const form = view.container.querySelector("form") as HTMLFormElement;
    await waitFor(() => expect(new FormData(form).get("startFrom")).toBe("type"));
    expect(
      (screen.getByRole("radio", { name: /A past project/ }) as HTMLInputElement).checked,
    ).toBe(false);
  });

  it("shows a refusal on a field no step holds", async () => {
    render(tree({ fieldErrors: { copyFromProjectId: "intakeCopySource" } }));
    await screen.findByText("Choose the past project to copy from.");
  });
});
