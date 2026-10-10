import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  AgencySlate,
  ApplicationForm,
  AvailabilityCalendar,
  EPKViewer,
  EngagementTimeline,
  OnboardingPacket,
  OpportunityCard,
  OpportunityFilters,
  PaymentTracker,
  PayoutDetailsForm,
  ProfileEditor,
  ProgressBar,
  RatingDialog,
  UpNextCard,
} from "../src/index.ts";
import { expectAccessible } from "./a11y.ts";

describe("opportunities", () => {
  it("shows Rate on Request, what is missing, and applies", async () => {
    const onApply = vi.fn();
    const onSave = vi.fn();
    const { container } = render(
      <div>
        <OpportunityCard
          org="Northwind Live"
          verified
          role="A1 Audio"
          pay={null}
          date="Nov 3"
          place="Miami"
          requirements={{ missing: ["OSHA 10", "W-9"] }}
          missingAction="Add Documents"
          deadline="Apply by Oct 30"
          onApply={onApply}
          onSave={onSave}
        />
        <OpportunityCard
          org="Harbor Light"
          role="Stagehand"
          pay="$420/day"
          date="Nov 4"
          place="Tampa"
          requirements={{ missing: [] }}
          deadline="Apply by Oct 31"
          saved
        />
      </div>,
    );
    expect(screen.getByText("Rate on Request")).toBeTruthy();
    expect(screen.getByText("Missing: OSHA 10 and W-9")).toBeTruthy();
    expect(screen.getByText("You meet every requirement")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Add Documents" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onApply).toHaveBeenCalled();
    expect(onSave).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Saved" }).getAttribute("aria-pressed")).toBe("true");
    await expectAccessible(container);
  });

  it("searches, toggles chips and switches the view", async () => {
    const onSearch = vi.fn();
    const onChipsChange = vi.fn();
    const onViewChange = vi.fn();
    const { container } = render(
      <OpportunityFilters
        placeholder="Role, skill or org"
        chips={["This Week", "Audio"]}
        active={["Audio"]}
        onSearch={onSearch}
        onChipsChange={onChipsChange}
        onViewChange={onViewChange}
      />,
    );
    await userEvent.type(screen.getByRole("textbox", { name: "Search opportunities" }), "a1");
    expect(onSearch).toHaveBeenLastCalledWith("a1");
    await userEvent.click(screen.getByRole("button", { name: "This Week" }));
    expect(onChipsChange).toHaveBeenLastCalledWith(["Audio", "This Week"]);
    await userEvent.click(screen.getByRole("button", { name: /Audio/ }));
    expect(onChipsChange).toHaveBeenLastCalledWith(["This Week"]);
    await userEvent.click(screen.getByRole("radio", { name: /Map/ }));
    expect(onViewChange).toHaveBeenLastCalledWith("map");
    await expectAccessible(container);
  });
});

describe("applications and staffing", () => {
  it("shows what is shared and submits", async () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <ApplicationForm
        role="A1 Audio"
        org="Northwind Live"
        shared={[
          { label: "Profile", on: true },
          { label: "Phone", on: false },
        ]}
        questions={["Recent shows?"]}
        onSubmit={onSubmit}
      />,
    );
    expect(screen.getByRole("group", { name: "What Northwind Live will see" })).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Profile" }) as HTMLInputElement).checked).toBe(
      true,
    );
    await userEvent.click(screen.getByRole("button", { name: "Submit Application" }));
    expect(onSubmit).toHaveBeenCalled();
    await expectAccessible(container);
  });

  it("selects roster staff against positions", async () => {
    const onSubmit = vi.fn();
    const onChange = vi.fn();
    const { container } = render(
      <AgencySlate
        positions={2}
        onChange={onChange}
        onSubmit={onSubmit}
        roster={[
          {
            name: "Ana Ruiz",
            role: "Stagehand",
            selected: true,
            certs: [{ label: "OSHA 10", ok: true }],
          },
          {
            name: "Ben Cole",
            role: "Rigger",
            selected: false,
            certs: [{ label: "ETCP", ok: false }],
          },
        ]}
      />,
    );
    expect(screen.getByText("1 of 2 positions")).toBeTruthy();
    await userEvent.click(screen.getByRole("checkbox", { name: "Include Ben Cole" }));
    expect(onChange).toHaveBeenLastCalledWith(["Ana Ruiz", "Ben Cole"]);
    expect(
      screen.getByRole("progressbar", { name: "Positions filled" }).getAttribute("aria-valuenow"),
    ).toBe("100");
    await userEvent.click(screen.getByRole("button", { name: "Submit Slate" }));
    expect(onSubmit).toHaveBeenCalledWith(["Ana Ruiz", "Ben Cole"]);
    await expectAccessible(container);
  });
});

describe("profile and press kit", () => {
  it("sets field visibility", async () => {
    const onVisibilityChange = vi.fn();
    const { container } = render(
      <ProfileEditor
        strength={60}
        nextStep="Add a headshot"
        onVisibilityChange={onVisibilityChange}
        fields={[{ label: "Phone", value: "555 0100", visibility: "private" }]}
      />,
    );
    expect(screen.getByText("60% complete")).toBeTruthy();
    await userEvent.click(screen.getByRole("radio", { name: "Public" }));
    expect(onVisibilityChange).toHaveBeenCalledWith("Phone", "public");
    await expectAccessible(container);
  });

  it("presents the press kit", async () => {
    const onMedia = vi.fn();
    const { container } = render(
      <EPKViewer
        artist="Luz Marina"
        headline="Latin pop"
        badges={["Verified"]}
        bio="Touring since 2019."
        media={[
          { type: "video", label: "Live set" },
          { type: "audio", label: "Single" },
          { type: "image", label: "Press photo" },
        ]}
        links={[{ label: "Stage plot", href: "https://example.org/plot" }]}
        onMedia={onMedia}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Single" }));
    expect(onMedia).toHaveBeenCalledWith("Single");
    expect(screen.getByRole("link", { name: /Stage plot/ }).getAttribute("target")).toBe("_blank");
    await expectAccessible(container);
  });
});

describe("calendar, packet and timeline", () => {
  it("marks available and booked days in text as well as color", async () => {
    const { container } = render(
      <AvailabilityCalendar
        month="2026-11-01"
        available={["2026-11-03"]}
        booked={["2026-11-04"]}
      />,
    );
    expect(screen.getByRole("table", { name: "November 2026" })).toBeTruthy();
    expect(screen.getAllByText("Booked", { exact: false }).length).toBeGreaterThan(1);
    await expectAccessible(container);
  });

  it("lists requirements with time left and starts items", async () => {
    const onStart = vi.fn();
    const { container } = render(
      <OnboardingPacket
        onStart={onStart}
        items={[
          { label: "W-9", state: "verified", blocking: true, minutes: 5 },
          { label: "I-9", state: "todo", blocking: true, minutes: 10, action: "Upload" },
          { label: "Handbook", state: "review", blocking: false, minutes: 15, note: "Sent Oct 2" },
          { label: "Background", state: "expired", blocking: true, minutes: 20 },
          { label: "Safety video", state: "todo", blocking: false, minutes: 12 },
        ]}
      />,
    );
    expect(screen.getByText("About 22 min left")).toBeTruthy();
    expect(screen.getByText("1 of 5 verified")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Upload" }));
    expect(onStart).toHaveBeenCalledWith("I-9");
    await expectAccessible(container);
  });

  it("marks the current engagement stage and payment step", async () => {
    const { container } = render(
      <div>
        <EngagementTimeline
          current={1}
          stages={[
            { label: "Offer", date: "Oct 1" },
            { label: "Onboarding", owner: "You" },
            { label: "Active" },
          ]}
        />
        <PaymentTracker
          invoiceKey="INV-204"
          title="Load-in crew"
          amount={1260}
          current={1}
          dates={["Oct 2"]}
          expected="Oct 9"
        />
        <ProgressBar label="Upload" value={140} />
      </div>,
    );
    expect(screen.getByText("Onboarding").closest("li")?.getAttribute("aria-current")).toBe("step");
    expect(screen.getByText("Expected Oct 9")).toBeTruthy();
    expect(screen.getByText("$1,260.00")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Upload" }).getAttribute("aria-valuenow")).toBe(
      "100",
    );
    await expectAccessible(container);
  });
});

describe("rating, payout and up next", () => {
  it("rates with arrow keys and submits", async () => {
    const onSubmit = vi.fn();
    render(<RatingDialog counterpart="Northwind Live" onSubmit={onSubmit} />);
    const dialog = screen.getByRole("dialog", { name: "Rate Northwind Live" });
    expect(
      (within(dialog).getByRole("button", { name: "Submit Rating" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await userEvent.click(within(dialog).getByRole("radio", { name: "3 stars" }));
    await userEvent.keyboard("{ArrowRight}");
    expect(
      within(dialog).getByRole("radio", { name: "4 stars" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("4 stars");
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    await userEvent.type(within(dialog).getByLabelText("Public comment"), "Great");
    await userEvent.click(within(dialog).getByRole("button", { name: "Submit Rating" }));
    expect(onSubmit).toHaveBeenCalledWith(2, "Great");
    await expectAccessible(document.body);
  });

  it("collects payout details and shows only the last four on file", async () => {
    const onSave = vi.fn();
    const { container } = render(
      <PayoutDetailsForm
        rail="ACH"
        onFile={{ bank: "First Bank", last4: "4421" }}
        onSave={onSave}
      />,
    );
    expect(screen.getByText("•••• 4421")).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Routing Number"), "011000015");
    await userEvent.type(screen.getByLabelText("Account Number"), "12345678");
    await userEvent.selectOptions(screen.getByLabelText("Account Type"), "savings");
    await userEvent.click(screen.getByRole("button", { name: "Save Securely" }));
    expect(onSave).toHaveBeenCalledWith({
      routing: "011000015",
      account: "12345678",
      type: "savings",
    });
    await expectAccessible(container);
  });

  it("leads with the next shift and one-tap actions", async () => {
    const onDirections = vi.fn();
    const { container } = render(
      <UpNextCard
        org="Northwind Live"
        countdown="in 2 d"
        title="Load-in"
        when="Nov 3, 7:00 AM"
        callTime="6:30 AM"
        address="Mana Wynwood"
        parking="Lot B"
        contact="Dana Ortiz"
        bring={["Gloves"]}
        onDirections={onDirections}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Directions" }));
    expect(onDirections).toHaveBeenCalled();
    expect(screen.getByText("Lot B")).toBeTruthy();
    await expectAccessible(container);
  });
});
