import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  AccessGridMatrix,
  AssertionRankBadge,
  CoordinateMatrix,
  EmergencyCodeCard,
  GateReadinessPanel,
  ProvenanceBadge,
  RadioChannelTable,
  ReconciliationTable,
  RunOfShowLive,
  StalenessIndicator,
  XOSProvider,
} from "../src/index.ts";
import { expectAccessible } from "./a11y.ts";

const criteria = [
  {
    code: "G3.PERMITS_FILED",
    label: "All required permits are filed.",
    result: "met" as const,
    blocking: true,
    evidence: "Permit packet",
  },
  {
    code: "G3.SITE_PLAN",
    label: "The site plan is approved.",
    result: "gap" as const,
    blocking: true,
    action: "Upload Plan",
  },
  {
    code: "G3.INSURANCE",
    label: "Insurance certificates are current.",
    result: "unknown" as const,
    blocking: false,
  },
];

describe("GateReadinessPanel", () => {
  it("counts criteria, blocks the next gate while a blocker is open and runs gap actions", async () => {
    const onAdvance = vi.fn();
    const onCriterionAction = vi.fn();
    const { container, rerender } = render(
      <GateReadinessPanel
        gate={3}
        code="ADV"
        name="Advance"
        nextLabel="Advance to Gate 4"
        criteria={criteria}
        onAdvance={onAdvance}
        onCriterionAction={onCriterionAction}
      />,
    );
    expect(screen.getByText("Gate 3 · Advance")).toBeTruthy();
    expect(screen.getByText("1 of 3 met")).toBeTruthy();
    expect(screen.getByText("1 blocking criterion open.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /Advance to Gate 4/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Upload Plan" }));
    expect(onCriterionAction).toHaveBeenCalledWith("G3.SITE_PLAN", "The site plan is approved.");
    expect(screen.getByRole("img", { name: "Gap" })).toBeTruthy();
    await expectAccessible(container);
    rerender(
      <GateReadinessPanel
        gate={3}
        code="ADV"
        name="Advance"
        nextLabel="Advance to Gate 4"
        criteria={criteria.map((c) => ({ ...c, result: "met" as const }))}
        onAdvance={onAdvance}
      />,
    );
    expect(screen.getByText("All blocking criteria met.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Advance to Gate 4/ }));
    expect(onAdvance).toHaveBeenCalled();
  });

  it("names the open blockers in the plural", () => {
    render(
      <GateReadinessPanel
        gate={3}
        code="ADV"
        name="Advance"
        nextLabel="Next"
        criteria={criteria.map((c) => ({ ...c, result: "gap" as const }))}
      />,
    );
    expect(screen.getByText("2 blocking criteria open.")).toBeTruthy();
  });
});

describe("badges", () => {
  it("renders provenance, assertion rank and staleness", async () => {
    const { container } = render(
      <div>
        <ProvenanceBadge source="Operator" rank={80} />
        <AssertionRankBadge label="Verified" rank={4} />
        <AssertionRankBadge label="Claimed" rank={1} />
        <AssertionRankBadge label="Reviewed" rank={3} />
        <StalenessIndicator months={6} />
        <StalenessIndicator months={13} basis="quote date" />
        <StalenessIndicator months={25} />
        <StalenessIndicator months={40} />
      </div>,
    );
    expect(screen.getByRole("img", { name: "Verified, rank 4 of 4" })).toBeTruthy();
    expect(screen.getByText("Degraded One Step").parentElement?.getAttribute("title")).toBe(
      "13 months since quote date",
    );
    expect(screen.getByText("Modeled")).toBeTruthy();
    expect(screen.getByText("Expired")).toBeTruthy();
    expect(screen.getByText("Current")).toBeTruthy();
    expect(screen.getByText("Provenance rank 80")).toBeTruthy();
    await expectAccessible(container);
  });
});

describe("tables", () => {
  it("reconciles requirements and sorts the radio plan numerically", async () => {
    const { container } = render(
      <div>
        <ReconciliationTable
          label="Venue reconciliation"
          rows={[
            { requirement: "Rigging points", capability: "48 points", result: "Met" },
            { requirement: "Shore power", capability: null, result: "Unknown" },
            { requirement: "Loading dock", capability: "None", result: "Gap" },
          ]}
        />
        <RadioChannelTable
          caption="Radio plan"
          channels={[
            { zone: 2, channel: 1, assignment: "Security", notes: "Perimeter" },
            { zone: 1, channel: 10, assignment: "Production", notes: "All calls" },
            { zone: 1, channel: 2, assignment: "Stage", notes: "Stage left" },
          ]}
        />
      </div>,
    );
    expect(screen.getByText("Not declared")).toBeTruthy();
    const radio = screen.getByRole("table", { name: "Radio plan" });
    const assignments = within(radio)
      .getAllByRole("row")
      .slice(1)
      .map((r) => r.children[2]?.textContent);
    expect(assignments).toEqual(["Stage", "Production", "Security"]);
    await expectAccessible(container);
  });
});

describe("EmergencyCodeCard", () => {
  it("resolves services from the jurisdiction and always prints the code", async () => {
    const { container } = render(
      <div>
        <EmergencyCodeCard
          recordKey="EMG-001"
          code="Code Red"
          name="Fire"
          swatch="ecode-red"
          domain="Site"
          steps={["Call {fire} and evacuate.", "Notify {ems}.", "Keep {unknown} as written."]}
          authorities={[
            { service: "ems", agency: "Miami Fire-Rescue EMS" },
            { service: "fire", agency: "Miami Fire-Rescue", contact: "911" },
            { service: "federal", agency: "FBI" },
          ]}
          channel="Zone 1, Channel 1"
        />
        <EmergencyCodeCard
          code="Code Adam"
          name="Missing child"
          swatch="ecode-adam"
          steps={["Alert {lawEnforcement}."]}
        />
      </div>,
    );
    expect(screen.getByText("Call Miami Fire-Rescue and evacuate.")).toBeTruthy();
    expect(screen.getByText("Keep {unknown} as written.")).toBeTruthy();
    expect(screen.getByText("Alert local law enforcement.")).toBeTruthy();
    const roles = screen.getAllByRole("term").map((d) => d.textContent);
    expect(roles).toEqual(["Fire", "EMS"]);
    expect(screen.getByRole("article", { name: "Code Red" })).toBeTruthy();
    await expectAccessible(container);
  });
});

describe("RunOfShowLive", () => {
  it("advances on Space and on Go and counts down", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onGo = vi.fn();
    const { container } = render(
      <RunOfShowLive
        current={0}
        nextInSeconds={45}
        showMode
        onGo={onGo}
        cues={[
          {
            number: "Q1",
            time: "19:00",
            title: "House to half",
            dept: "5000",
            durationSeconds: 20,
          },
          { number: "Q2", time: "19:01", title: "Walk-in music", durationSeconds: 90 },
          { number: "Q3", time: "19:03", title: "Headliner" },
        ]}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByText("00:42")).toBeTruthy();
    const region = screen.getByRole("region", { name: "Run of show" });
    act(() => region.focus());
    await userEvent.keyboard(" ");
    expect(onGo).toHaveBeenLastCalledWith(1);
    expect(screen.getByText("Walk-in music").closest("li")?.getAttribute("aria-current")).toBe(
      "true",
    );
    expect(screen.getByText("01:30")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Go/ }));
    await userEvent.click(screen.getByRole("button", { name: /Go/ }));
    expect(onGo).toHaveBeenLastCalledWith(2);
    await expectAccessible(container);
    vi.useRealTimers();
  });
});

describe("matrices", () => {
  it("navigates the coordinate grid and drills into a cell", async () => {
    const onCellSelect = vi.fn();
    const { container } = render(
      <CoordinateMatrix
        label="Coordinate matrix"
        corner="Department"
        rows={[
          { code: "5000", name: "Production" },
          { code: "6000", name: "Operations" },
        ]}
        cols={[
          { gate: 3, code: "ADV", name: "Advance" },
          { gate: 5, code: "BLD", name: "Build" },
        ]}
        cells={{ "5000|ADV": 12, "6000|BLD": 3 }}
        onCellSelect={onCellSelect}
      />,
    );
    const first = screen.getByRole("gridcell", { name: "Production, Advance: 12 records" });
    act(() => first.focus());
    await userEvent.keyboard("{Enter}");
    expect(onCellSelect).toHaveBeenCalledWith("5000", "ADV");
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Production, Build: none");
    await userEvent.keyboard("{Control>}{End}{/Control}{Enter}");
    expect(onCellSelect).toHaveBeenLastCalledWith("6000", "BLD");
    await userEvent.keyboard("{Home}{ArrowUp}");
    expect(document.activeElement).toBe(first);
    await expectAccessible(container);
  });

  it("toggles access grants from the keyboard and mirrors arrows in right-to-left", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <XOSProvider locale="ar-XB">
        <AccessGridMatrix
          label="Access grid"
          zones={["Stage", "Backstage"]}
          categories={[
            { name: "Artist", color: 1 },
            { name: "Crew", color: 2 },
          ]}
          grants={["Artist|Stage"]}
          onChange={onChange}
        />
      </XOSProvider>,
    );
    const cell = screen.getByRole("gridcell", { name: "Artist in Stage: allowed" });
    expect(cell.getAttribute("aria-selected")).toBe("true");
    act(() => cell.focus());
    await userEvent.keyboard("{ArrowLeft}");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Artist in Backstage: denied");
    await userEvent.keyboard(" ");
    expect(onChange).toHaveBeenLastCalledWith(["Artist|Stage", "Artist|Backstage"]);
    await userEvent.click(cell);
    expect(onChange).toHaveBeenLastCalledWith(["Artist|Backstage"]);
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledTimes(3);
    await expectAccessible(container);
  });
});
