// @vitest-environment jsdom
/**
 * The help tour offer, tips and tour steps beside the cookie bar (release 4.19, decision 2026-11-27).
 * The bar sits at the bottom edge, and the floating help cards sit there too on the toast layer, so
 * while the bar is on the page the shell passes `consentBar` and the panel offers no tour and shows
 * no tip: nothing covers the bar's text or links, and the offer is not recorded as made behind it.
 * Once the visitor answers, the server re-renders the shell without the bar and the offer appears. A
 * tour the person starts on purpose sits above the bar's tallest height. The server actions are
 * replaced, so nothing leaves the test.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HelpPanelState } from "@/lib/help/actions";

const actions = vi.hoisted(() => ({
  recordTourAction: vi.fn(async () => ({ ok: true })),
  dismissTipAction: vi.fn(async () => ({ ok: true })),
}));
const search = vi.hoisted(() => ({ value: new URLSearchParams() }));

vi.mock("@/lib/help/actions", () => actions);
vi.mock("next/navigation", () => ({ useSearchParams: () => search.value }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));

const { CARD_POSITION, CARD_POSITION_ABOVE_CONSENT, HelpPanel } =
  await import("@/components/help/help-panel");

const STATE: HelpPanelState = {
  tours: [],
  dismissedTips: [],
  canContactPlatform: false,
  platformChannel: null,
  orgSupport: null,
} as unknown as HelpPanelState;

function panel(props: { consentBar: boolean; nodeId: string }) {
  return (
    <HelpPanel
      org="acme"
      state={STATE}
      loadFailed={false}
      nodeId={props.nodeId}
      open={false}
      setOpen={() => undefined}
      view={{ kind: "home" }}
      setView={() => undefined}
      consentBar={props.consentBar}
    />
  );
}

const cards = () => document.querySelectorAll("[data-help-card]");

beforeEach(() => {
  actions.recordTourAction.mockClear();
  actions.dismissTipAction.mockClear();
  search.value = new URLSearchParams();
});
afterEach(cleanup);

describe("the help cards beside the cookie bar", () => {
  it("offer no tour while the bar is on the page, and do not record the offer as made", async () => {
    // home has the getting-started tour, never offered to this person.
    const { rerender } = render(panel({ consentBar: true, nodeId: "home" }));
    await act(async () => undefined);
    expect(cards()).toHaveLength(0);
    expect(actions.recordTourAction).not.toHaveBeenCalled();

    // The visitor answers the bar; the shell re-renders without it and the offer appears.
    rerender(panel({ consentBar: false, nodeId: "home" }));
    await act(async () => undefined);
    expect(cards()).toHaveLength(1);
    expect(screen.getByText("tours.offerTitle")).toBeTruthy();
    expect(actions.recordTourAction).toHaveBeenCalledWith(
      "acme",
      "atlas.getting-started",
      "Offered",
    );
  });

  it("show no tip while the bar is on the page", async () => {
    // project.gates has the gates tip and no tour.
    const { rerender } = render(panel({ consentBar: true, nodeId: "project.gates" }));
    await act(async () => undefined);
    expect(cards()).toHaveLength(0);

    rerender(panel({ consentBar: false, nodeId: "project.gates" }));
    await act(async () => undefined);
    expect(cards()).toHaveLength(1);
    expect(screen.getByText("tips.gates.title")).toBeTruthy();
  });

  it("put a tour the person starts above the bar's tallest height, and the tab bar on a phone", async () => {
    search.value = new URLSearchParams("tour=atlas.getting-started");
    render(panel({ consentBar: true, nodeId: "home" }));
    await act(async () => undefined);
    const step = document.querySelector<HTMLElement>("[data-help-tour-step]");
    expect(step).not.toBeNull();
    const classes = step?.className.split(" ") ?? [];
    expect(classes).toEqual(expect.arrayContaining(CARD_POSITION_ABOVE_CONSENT.split(" ")));
    expect(classes).not.toContain("bottom-16");
    expect(CARD_POSITION_ABOVE_CONSENT).toContain(
      "bottom-[calc(var(--ui-consent-bar-shell-max)+var(--space-16))]",
    );
    expect(CARD_POSITION_ABOVE_CONSENT).toContain(
      "max-md:bottom-[calc(var(--ui-consent-bar-shell-max)+var(--ui-bottom-bar)+var(--space-16))]",
    );
  });

  it("keep the usual place for a tour with no bar on the page", async () => {
    search.value = new URLSearchParams("tour=atlas.getting-started");
    render(panel({ consentBar: false, nodeId: "home" }));
    await act(async () => undefined);
    const step = document.querySelector<HTMLElement>("[data-help-tour-step]");
    expect(step?.className.split(" ")).toEqual(expect.arrayContaining(CARD_POSITION.split(" ")));
  });
});
