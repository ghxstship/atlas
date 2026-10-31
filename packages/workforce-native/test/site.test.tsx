import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DoorGuest, LostItem, OccupancyCounter, WeatherBoard } from "@xos/data/workforce-site";
import {
  DoorCheckInScreen,
  LostFoundScreen,
  OccupancyCounterScreen,
  WeatherScreen,
  occupancyLevel,
  workforceScreens,
  type DoorCheckInScreenLabels,
  type LostFoundScreenLabels,
  type OccupancyCounterScreenLabels,
  type WeatherScreenLabels,
} from "../src/index.ts";
import { at, expectAccessible, labels, ok, refused } from "./helpers.tsx";

const button = (name: string | RegExp) => screen.getByRole("button", { name });
const press = async (name: string | RegExp) => {
  await act(async () => {
    fireEvent.click(button(name));
  });
};

const counter = (over: Partial<OccupancyCounter> = {}): OccupancyCounter => ({
  id: "oc1",
  projectId: "prj",
  spaceId: null,
  name: "Pier Deck Doors",
  basis: "Space Capacity",
  metricItem: null,
  permittedLoad: 300,
  count: 250,
  alertLevel: 80,
  closedAt: null,
  ...over,
});

describe("occupancyLevel", () => {
  it("reads the highest level reached", () => {
    expect(occupancyLevel(100, 300)).toBeNull();
    expect(occupancyLevel(240, 300)).toBe(80);
    expect(occupancyLevel(275, 300)).toBe(90);
    expect(occupancyLevel(300, 300)).toBe(100);
    expect(occupancyLevel(5, 0)).toBeNull();
  });
});

describe("OccupancyCounterScreen", () => {
  it("counts in and out at a door and shows the alert level", async () => {
    const onCount = vi.fn(ok);
    const ol = labels<OccupancyCounterScreenLabels>(["add", "remove", "count", "percent", "level"]);
    const { container, rerender } = render(
      <OccupancyCounterScreen
        status="ready"
        labels={ol}
        counters={[
          counter(),
          counter({ id: "oc2", name: "Bar Tent", count: 0, permittedLoad: 0 }),
          counter({ id: "oc3", closedAt: "2026-10-01T00:00:00Z" }),
        ]}
        onCount={onCount}
      />,
    );
    expect(screen.getByText("level(80)")).toBeTruthy();
    expect(screen.getByText("count(250,300)")).toBeTruthy();
    expect(screen.getByText("closed")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("door"), { target: { value: " Gate A " } });
    await press("add(1)");
    expect(onCount).toHaveBeenLastCalledWith("oc1", 1, "Gate A");
    await press("add(5)");
    expect(onCount).toHaveBeenLastCalledWith("oc1", 5, "Gate A");
    fireEvent.change(screen.getByLabelText("door"), { target: { value: "" } });
    await press("remove(1)");
    expect(onCount).toHaveBeenLastCalledWith("oc1", -1, null);
    await expectAccessible(container);
    fireEvent.click(screen.getByRole("radio", { name: "Bar Tent" }));
    expect(screen.getByLabelText("percent(0)")).toBeTruthy();

    rerender(
      <OccupancyCounterScreen
        status="ready"
        labels={ol}
        counters={[counter({ count: 310 })]}
        onCount={refused("The counter is closed.")}
      />,
    );
    expect(screen.getByText("level(100)")).toBeTruthy();
    await press("add(1)");
    expect(screen.getByText("The counter is closed.")).toBeTruthy();
  });

  it("shows the empty state", () => {
    const onEmptyAction = vi.fn();
    render(
      <OccupancyCounterScreen
        status="ready"
        labels={labels<OccupancyCounterScreenLabels>()}
        counters={[]}
        onCount={ok}
        onEmptyAction={onEmptyAction}
      />,
    );
    fireEvent.click(button("emptyAction"));
    expect(onEmptyAction).toHaveBeenCalled();
  });
});

const board: WeatherBoard = {
  thresholds: [
    {
      id: "th1",
      hazard: "Wind",
      level: "Restrict",
      value: 30,
      unit: "mph",
      sourceNote: "Plan 4.2",
    },
  ],
  readings: [
    {
      id: "wr1",
      hazard: "Wind",
      value: 24,
      observedAt: "2026-10-02T09:00:00Z",
      recordedBy: "Ana",
      source: "Manual",
    },
  ],
  alerts: [
    {
      id: "wa1",
      hazard: "Wind",
      level: "Monitor",
      issuedAt: "2026-10-02T09:00:00Z",
      clearedAt: null,
    },
    {
      id: "wa2",
      hazard: "Heat",
      level: "Evacuate",
      issuedAt: "2026-10-01T09:00:00Z",
      clearedAt: "2026-10-01T10:00:00Z",
    },
  ],
  roles: [],
};

const weatherLabels = labels<WeatherScreenLabels>(
  ["value", "alertLine", "readingLine", "thresholdLine", "holdSince", "defaultHold"],
  ["hazards", "levels", "severities"],
);

describe("WeatherScreen", () => {
  it("shows active alerts, readings and thresholds and records a reading", async () => {
    const onRecord = vi.fn(ok);
    const { container } = render(
      <WeatherScreen status="ready" labels={weatherLabels} board={board} onRecord={onRecord} />,
    );
    expect(
      screen.getByText('alertLine("hazards.Wind","levels.Monitor","2026-10-02T09:00:00Z")'),
    ).toBeTruthy();
    expect(screen.queryByText(/levels.Evacuate/)).toBeNull();
    expect(screen.getByText('readingLine(24,"mph","2026-10-02T09:00:00Z")')).toBeTruthy();
    expect(screen.getByText('thresholdLine("levels.Restrict",30,"mph","Plan 4.2")')).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "hazards.Lightning" }));
    const field = screen.getByLabelText('value("mi")');
    fireEvent.change(field, { target: { value: "-2" } });
    expect(screen.getByText("valueError")).toBeTruthy();
    fireEvent.change(field, { target: { value: "6" } });
    await expectAccessible(container);
    await press("save");
    expect(onRecord).toHaveBeenCalledWith("Lightning", 6);
    expect((field as HTMLInputElement).value).toBe("");
  });

  it("lets a dispatcher call a hold prefilled from the template, and shows the hold and warnings (B8)", async () => {
    const onCallHold = vi.fn(ok);
    const feed = {
      status: {
        supported: true,
        feedId: "f1",
        lastSuccessAt: null,
        lastFailureAt: null,
        lastError: null,
        failuresSinceSuccess: 0,
      },
      warnings: [
        {
          id: "w1",
          event: "Severe Thunderstorm Warning",
          severity: "Severe" as const,
          headline: "Until 9:45 PM",
          description: null,
          instruction: null,
          onset: null,
          endsAt: null,
          expiresAt: null,
        },
      ],
      forecast: [],
      openHold: null,
      templates: { Hold: { id: "t1", body: "Stop work and shelter." } },
    };
    const { rerender } = render(
      <WeatherScreen
        status="ready"
        labels={weatherLabels}
        board={board}
        onRecord={ok}
        feed={feed}
        canDispatch
        onCallHold={onCallHold}
        onAllClear={vi.fn(ok)}
      />,
    );
    expect(screen.getByText("Severe Thunderstorm Warning")).toBeTruthy();
    fireEvent.click(button("callHold"));
    expect((screen.getByLabelText("message") as HTMLTextAreaElement).value).toBe(
      "Stop work and shelter.",
    );
    await press("send");
    expect(onCallHold).toHaveBeenCalledWith("Stop work and shelter.", "Wind");
    rerender(
      <WeatherScreen
        status="ready"
        labels={weatherLabels}
        board={board}
        onRecord={ok}
        feed={{
          ...feed,
          openHold: {
            id: "h1",
            hazard: null,
            message: "Stop work and shelter.",
            calledAt: "2026-10-02T09:05:00Z",
            clearedAt: null,
            allClearMessage: null,
          },
        }}
        canDispatch={false}
      />,
    );
    expect(
      screen.getByText('holdSince("2026-10-02T09:05:00Z"): Stop work and shelter.'),
    ).toBeTruthy();
    expect(screen.queryByText("callHold")).toBeNull();
  });

  it("shows the quiet board and a missing board", () => {
    const { rerender } = render(
      <WeatherScreen
        status="ready"
        labels={weatherLabels}
        board={{ thresholds: [], readings: [], alerts: [], roles: [] }}
        onRecord={ok}
      />,
    );
    expect(screen.getByText("noAlerts")).toBeTruthy();
    expect(screen.getByText("noReadings")).toBeTruthy();
    expect(screen.getByText("noThresholds")).toBeTruthy();
    rerender(<WeatherScreen status="ready" labels={weatherLabels} board={null} onRecord={ok} />);
    expect(screen.getByText("errorTitle")).toBeTruthy();
  });
});

const guest = (over: Partial<DoorGuest> = {}): DoorGuest => ({
  entryId: "g1",
  name: "Avery Brooks",
  plusOnes: 2,
  state: "Approved",
  note: "Artist family",
  checkedInAt: null,
  plusOnesAdmitted: null,
  door: null,
  passCode: null,
  passCategoryCode: null,
  passCategoryName: null,
  tableLabel: null,
  hostPersonId: null,
  ...over,
});

describe("DoorCheckInScreen", () => {
  it("admits a guest with fewer plus-ones at a door", async () => {
    const onCheckIn = vi.fn(ok);
    const onSearch = vi.fn();
    const dl = labels<DoorCheckInScreenLabels>([
      "sheetTitle",
      "plusOnes",
      "admitted",
      "passType",
      "table",
    ]);
    const { container } = render(
      <DoorCheckInScreen
        status="ready"
        labels={dl}
        guests={[
          guest(),
          guest({
            entryId: "g2",
            name: "Casey Morgan",
            state: "Checked In",
            note: null,
            checkedInAt: "2026-10-02T19:00:00Z",
            plusOnesAdmitted: 1,
            door: "Gate A",
          }),
        ]}
        search=""
        onSearch={onSearch}
        onCheckIn={onCheckIn}
      />,
    );
    expect(screen.getByText('admitted(1,"Gate A","2026-10-02T19:00:00Z")')).toBeTruthy();
    fireEvent.change(screen.getByLabelText("search"), { target: { value: "av" } });
    expect(onSearch).toHaveBeenCalledWith("av");
    fireEvent.change(screen.getByLabelText("door"), { target: { value: "Gate B" } });
    fireEvent.click(button("checkIn"));
    expect(screen.getByText("plusOnes(2,2)")).toBeTruthy();
    fireEvent.click(button("fewer"));
    fireEvent.click(button("fewer"));
    fireEvent.click(button("more"));
    expect(screen.getByText("plusOnes(1,2)")).toBeTruthy();
    await expectAccessible(container);
    await press("confirm");
    expect(onCheckIn).toHaveBeenCalledWith("g1", 1, "Gate B");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("finds a guest by the pass the door scans, and says when a pass is not on the list (B8)", async () => {
    const onCheckIn = vi.fn(ok);
    const dl = labels<DoorCheckInScreenLabels>([
      "sheetTitle",
      "plusOnes",
      "admitted",
      "passType",
      "table",
    ]);
    const listed = guest({
      passCode: "GP-ABCDEFGHIJ",
      passCategoryCode: "VIP",
      passCategoryName: "VIP Guest",
      tableLabel: "Table 4",
    });
    const { rerender } = render(
      <DoorCheckInScreen
        status="ready"
        labels={dl}
        guests={[listed]}
        search=""
        onSearch={vi.fn()}
        onCheckIn={onCheckIn}
      />,
    );
    expect(screen.getByText('passType("VIP Guest") · table("Table 4")')).toBeTruthy();
    fireEvent.change(screen.getByLabelText("pass"), { target: { value: "XOSGP1:GP-ZZZZZZZZZZ" } });
    fireEvent.click(button("checkPass"));
    expect(screen.getByText("passNotListed")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("pass"), { target: { value: "XOSGP1:GP-ABCDEFGHIJ" } });
    fireEvent.click(button("checkPass"));
    expect(screen.getByText("plusOnes(2,2)")).toBeTruthy();
    await press("confirm");
    expect(onCheckIn).toHaveBeenCalledWith("g1", 2, null);
    rerender(
      <DoorCheckInScreen
        status="error"
        labels={dl}
        guests={[]}
        search=""
        onSearch={vi.fn()}
        onCheckIn={onCheckIn}
      />,
    );
    expect(screen.getByText("errorSentence passOffline")).toBeTruthy();
  });

  it("keeps the sheet open on a refusal and clears an empty search", async () => {
    const onSearch = vi.fn();
    const dl = labels<DoorCheckInScreenLabels>([
      "sheetTitle",
      "plusOnes",
      "admitted",
      "passType",
      "table",
    ]);
    const { rerender } = render(
      <DoorCheckInScreen
        status="ready"
        labels={dl}
        guests={[guest({ note: null })]}
        search=""
        onSearch={onSearch}
        onCheckIn={refused("Already checked in.")}
      />,
    );
    fireEvent.click(button("checkIn"));
    await press("confirm");
    expect(screen.getByText("Already checked in.")).toBeTruthy();
    const closers = screen.getAllByRole("button", { name: "close" });
    fireEvent.click(at(closers, -1));
    rerender(
      <DoorCheckInScreen
        status="ready"
        labels={dl}
        guests={[]}
        search="x"
        onSearch={onSearch}
        onCheckIn={ok}
      />,
    );
    fireEvent.click(button("clearSearch"));
    expect(onSearch).toHaveBeenCalledWith("");
  });
});

const item = (over: Partial<LostItem> = {}): LostItem => ({
  id: "i1",
  projectId: "prj",
  number: "LF-0001",
  category: "Wallet",
  description: "Brown leather wallet",
  foundAt: "2026-10-02T20:00:00Z",
  foundLocation: "Bar 2",
  storageLocation: "Locker 4",
  loggedBy: "Ana",
  state: "Claimed",
  claims: [
    {
      id: "cl1",
      claimantName: "Sam",
      claimantContact: "sam@example.com",
      proof: "Library card",
      decidedAt: null,
      returned: null,
      note: null,
      createdAt: "2026-10-02T21:00:00Z",
    },
  ],
  ...over,
});

describe("LostFoundScreen", () => {
  it("lists items and logs a found item", async () => {
    const onLog = vi.fn(ok);
    const onOpenItem = vi.fn();
    const ll = labels<LostFoundScreenLabels>(["meta", "itemTitle"], ["categories", "states"]);
    const { container, rerender } = render(
      <LostFoundScreen
        status="ready"
        labels={ll}
        items={[item()]}
        onLog={onLog}
        onOpenItem={onOpenItem}
      />,
    );
    expect(screen.getByText('meta("LF-0001","Bar 2",1)')).toBeTruthy();
    expect(screen.getByLabelText("states.Claimed")).toBeTruthy();
    fireEvent.click(screen.getByText('itemTitle("categories.Wallet","Brown leather wallet")'));
    expect(onOpenItem).toHaveBeenCalledWith("i1");
    fireEvent.click(button("log"));
    fireEvent.click(screen.getByRole("radio", { name: "categories.Keys" }));
    fireEvent.change(screen.getByLabelText("description"), { target: { value: "Car keys" } });
    fireEvent.change(screen.getByLabelText("foundLocation"), { target: { value: "Gate A" } });
    await expectAccessible(container);
    await press("save");
    expect(onLog).toHaveBeenCalledWith({
      category: "Keys",
      description: "Car keys",
      foundLocation: "Gate A",
      storageLocation: null,
    });
    rerender(
      <LostFoundScreen
        status="ready"
        labels={ll}
        items={[]}
        onLog={onLog}
        onOpenItem={onOpenItem}
      />,
    );
    fireEvent.click(at(screen.getAllByRole("button", { name: "log" }), 0));
    fireEvent.change(screen.getByLabelText("description"), { target: { value: "Hat" } });
    fireEvent.change(screen.getByLabelText("foundLocation"), { target: { value: "Bar 1" } });
    fireEvent.change(screen.getByLabelText("storageLocation"), { target: { value: "Bin 2" } });
    await press("save");
    expect(onLog).toHaveBeenLastCalledWith({
      category: "Keys",
      description: "Hat",
      foundLocation: "Bar 1",
      storageLocation: "Bin 2",
    });
  });
});

describe("workforceScreens", () => {
  it("names every exported screen once with its sitemap node", async () => {
    const mod = await import("../src/index.ts");
    const names = workforceScreens.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const s of workforceScreens)
      expect(typeof (mod as Record<string, unknown>)[s.name]).toBe("function");
    const exported = Object.keys(mod).filter((k) => k.endsWith("Screen"));
    expect(exported.sort()).toEqual([...names].sort());
  });
});
