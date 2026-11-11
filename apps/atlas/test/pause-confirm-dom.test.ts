// @vitest-environment jsdom
/**
 * Pause billing, Cancel scheduled pause and Resume now acted on one click and never showed their success message
 * (crawl 4.9): each posts to Stripe at once, and a success swaps the panel's form for the other one, unmounting the
 * message with it. Each now asks first in a dialog, and the outcome lives in the area around both forms.
 */
import { getMessages } from "@xos/i18n";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { createElement as h, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
  pause: vi.fn(async () => ({ ok: true })),
  resume: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/billing/actions", () => ({
  pauseSubscriptionAction: actions.pause,
  resumeSubscriptionAction: actions.resume,
}));
vi.mock("@/components/auth/security/step-up", () => ({ useStepUpForm: () => null }));
vi.mock("@/components/settings/contributions/b16-actions", () => ({
  addBlocklistEntryAction: vi.fn(),
  confirmAgentProposalAction: vi.fn(),
  registerMcpConnectorAction: vi.fn(),
  rejectAgentProposalAction: vi.fn(),
  removeBlocklistEntryAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
}));

const { PauseArea, PauseForm, ResumeForm } = await import("@/components/settings/b16-forms");

afterEach(() => {
  cleanup();
  actions.pause.mockClear();
  actions.resume.mockClear();
});

const confirm = { title: "Resume billing now?", body: "Stripe charges today.", cancel: "Go back" };
const intl = (children: ReactNode) =>
  h(NextIntlClientProvider, {
    locale: "en-US",
    messages: getMessages("en-US"),
    timeZone: "America/New_York",
    children,
  });

const resume = () =>
  h(ResumeForm, {
    org: "acme",
    label: "Resume now",
    note: null,
    done: "Billing has resumed.",
    refusals: { other: "Something went wrong." },
    confirm,
  });
const pause = () =>
  h(PauseForm, {
    org: "acme",
    previews: ["Pauses on Dec 1."],
    labels: { months: "Length", options: ["1 month"], pause: "Pause billing", paused: "Paused." },
    refusals: { other: "Something went wrong." },
    confirm: { title: "Pause billing?", body: "Read-only while paused.", cancel: "Go back" },
  });

describe("the pause panel", () => {
  it("asks before resuming, and keeps the success once the form swaps", async () => {
    const { rerender } = render(intl(h(PauseArea, null, resume())));
    await userEvent.click(screen.getByRole("button", { name: "Resume now" }));
    expect(actions.resume).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Stripe charges today.")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Resume now" }));
    await waitFor(() => expect(actions.resume).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("Billing has resumed.")).toBeTruthy());
    // The server re-renders the panel with the Pause form in place of the Resume form.
    await act(async () => rerender(intl(h(PauseArea, null, pause()))));
    expect(screen.getByText("Billing has resumed.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause billing" })).toBeTruthy();
  });

  it("going back sends nothing", async () => {
    render(intl(h(PauseArea, null, pause())));
    await userEvent.click(screen.getByRole("button", { name: "Pause billing" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Pauses on Dec 1\. Read-only while paused\./)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Go back" }));
    expect(actions.pause).not.toHaveBeenCalled();
  });
});
