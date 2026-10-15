import { fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  Badge,
  Button,
  Card,
  ChecklistRunner,
  ClockButton,
  Icon,
  IconButton,
  ListRow,
  OfflineBanner,
  QuickIncidentSheet,
  ScanSheet,
  SegmentedControl,
  Sheet,
  ShiftCard,
  StateChip,
  StateIcon,
  SyncConflictSheet,
  TabBar,
  Tag,
  Text,
  ThemeProvider,
  nativeComponentStatus,
  type HapticKind,
} from "../src/index.ts";

async function expectAccessible(node: Element): Promise<void> {
  const results = await axe.run(node, {
    rules: { "color-contrast": { enabled: false } },
    resultTypes: ["violations"],
  });
  const blocking = results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(blocking).toEqual([]);
}

function withHaptics(ui: ReactElement, onHaptic: (k: HapticKind) => void) {
  return render(
    <ThemeProvider preference="sunlight" onHaptic={onHaptic}>
      {ui}
    </ThemeProvider>,
  );
}

describe("foundations", () => {
  it("draws text, registered icons and every state icon", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { container } = render(
      <div>
        <Text heading variant="heading20" tone="accent">
          Today
        </Text>
        <Text tone="danger" numberOfLines={1}>
          Late
        </Text>
        <Icon name="map-pin" label="Venue" />
        <Icon name="more" />
        <Icon name="NoSuchGlyph" />
        <Icon name="NoSuchGlyph" />
        {(
          [
            "proposed",
            "ready",
            "scheduled",
            "active",
            "blocked",
            "in-review",
            "complete",
            "deferred",
            "canceled",
          ] as const
        ).map((s) => (
          <StateIcon key={s} state={s} />
        ))}
      </div>,
    );
    expect(screen.getByRole("heading", { name: "Today" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Venue" })).toBeTruthy();
    expect(warn).toHaveBeenCalledOnce();
    expect(container.querySelectorAll("svg").length).toBeGreaterThan(9);
    await expectAccessible(container);
    warn.mockRestore();
  });

  it("marks the shipped components", () => {
    expect(nativeComponentStatus.ClockButton).toBe("shipped");
    expect(nativeComponentStatus.SignaturePad).toBe("published");
  });
});

describe("primitives", () => {
  it("presses buttons with haptics and refuses disabled and loading presses", async () => {
    const onPress = vi.fn();
    const onHaptic = vi.fn();
    const { container } = withHaptics(
      <div>
        <Button label="Save" variant="primary" icon="Check" onPress={onPress} />
        <Button label="Busy" loading onPress={onPress} />
        <Button label="Off" variant="danger" disabled onPress={onPress} />
        <Button label="Ghost" variant="ghost" size="lg" block onPress={onPress} />
        <IconButton icon="Search" label="Search" variant="secondary" onPress={onPress} />
        <IconButton icon="Search" label="Disabled search" disabled />
      </div>,
      onHaptic,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Busy" }));
    fireEvent.click(screen.getByRole("button", { name: "Off" }));
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(onPress).toHaveBeenCalledTimes(2);
    expect(onHaptic).toHaveBeenCalledWith("impact");
    await expectAccessible(container);
  });

  it("holds to confirm instead of firing on tap", () => {
    const onPress = vi.fn();
    render(
      <Button
        label="Send"
        holdToConfirm={{ seconds: 1, hint: "Hold to send" }}
        onPress={onPress}
      />,
    );
    const button = screen.getByRole("button", { name: "Send" });
    fireEvent.click(button);
    expect(onPress).not.toHaveBeenCalled();
    fireEvent.contextMenu(button);
    expect(onPress).toHaveBeenCalledOnce();
  });

  it("switches segments", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        label="Mode"
        value="a"
        options={[
          { value: "a", label: "Asset", icon: "Package" },
          { value: "b", label: "Receiving" },
        ]}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Asset" }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: "Receiving" }));
    expect(onChange).toHaveBeenCalledWith("b");
  });
});

describe("data", () => {
  it("renders chips, badges, tags and cards", async () => {
    const onPress = vi.fn();
    const { container } = render(
      <div>
        <StateChip state="active" label="Active" />
        <StateChip state="blocked" label="Blocked" compact />
        <Badge count={4} tone="danger" label="4 unread" />
        <Badge count={2} />
        {(["neutral", "accent", "success", "warning", "danger"] as const).map((tone) => (
          <Tag key={tone} tone={tone} label={tone} />
        ))}
        <Card title="Load In" meta={<Text>2 h</Text>} footer={<Text>Footer</Text>}>
          <Text>Body</Text>
        </Card>
        <Card title="Open" onPress={onPress}>
          <Text>Tap</Text>
        </Card>
      </div>,
    );
    expect(screen.getByRole("img", { name: "Blocked" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "4 unread" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Open/ }));
    expect(onPress).toHaveBeenCalledOnce();
    await expectAccessible(container);
  });

  it("runs swipe actions through accessibility actions", async () => {
    const complete = vi.fn();
    const snooze = vi.fn();
    const onPress = vi.fn();
    const { container } = render(
      <div>
        <ListRow
          title="Check fire lane"
          subtitle="Gate B"
          icon="SquareCheck"
          trailing={<Text>6 PM</Text>}
          onPress={onPress}
          swipeStart={{ label: "Complete", icon: "Check", onAction: complete }}
          swipeEnd={{ label: "Snooze", icon: "Clock", tone: "warning", onAction: snooze }}
        />
        <ListRow title="Static row" />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Complete" }));
    fireEvent.click(screen.getByRole("button", { name: "Snooze" }));
    fireEvent.click(screen.getByRole("button", { name: /Check fire lane/ }));
    expect([complete, snooze, onPress].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
    await expectAccessible(container);
  });
});

describe("overlays", () => {
  it("opens and closes the sheet", async () => {
    const onClose = vi.fn();
    const { container, rerender } = render(
      <Sheet
        open
        title="Resolve Conflict"
        closeLabel="Close"
        onClose={onClose}
        footer={<Text>Foot</Text>}
      >
        <Text>Body</Text>
      </Sheet>,
    );
    expect(screen.getByRole("dialog", { name: "Resolve Conflict" })).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[1] as Element);
    expect(onClose).toHaveBeenCalledOnce();
    await expectAccessible(container);
    rerender(
      <Sheet open={false} title="Hidden" closeLabel="Close" onClose={onClose}>
        <Text>Body</Text>
      </Sheet>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("selects tabs and the center action", async () => {
    const onSelect = vi.fn();
    const onScan = vi.fn();
    const { container, rerender } = render(
      <TabBar
        label="Compass"
        active="today"
        onSelect={onSelect}
        center={{ label: "Scan", icon: "ScanLine", onPress: onScan }}
        items={[
          { key: "today", label: "Today", icon: "Sun" },
          { key: "schedule", label: "Schedule", icon: "Calendar" },
          { key: "inbox", label: "Inbox", icon: "Inbox", badge: 3 },
          { key: "more", label: "More", icon: "Menu" },
        ]}
      />,
    );
    expect(screen.getByRole("tab", { name: "Today" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Inbox, 3" }));
    expect(onSelect).toHaveBeenCalledWith("inbox");
    fireEvent.click(screen.getByRole("tab", { name: "Scan" }));
    expect(onScan).toHaveBeenCalledOnce();
    await expectAccessible(container);
    rerender(
      <TabBar
        label="Compass"
        active="a"
        onSelect={onSelect}
        items={[{ key: "a", label: "A", icon: "Sun" }]}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "A" }));
  });
});

describe("Compass", () => {
  it("clocks in with haptics and refuses when blocked", async () => {
    const onPress = vi.fn();
    const onHaptic = vi.fn();
    const { container, rerender } = withHaptics(
      <ClockButton
        state="out"
        label="Clock In"
        detail="Starts 6:00 PM"
        geofence="You're at the venue"
        geofenceOk
        onPress={onPress}
      />,
      onHaptic,
    );
    fireEvent.click(screen.getByRole("button", { name: "Clock In, Starts 6:00 PM" }));
    expect(onPress).toHaveBeenCalledOnce();
    expect(onHaptic).toHaveBeenCalledWith("success");
    await expectAccessible(container);
    rerender(
      <ThemeProvider onHaptic={onHaptic}>
        <ClockButton
          state="blocked"
          label="Outside the venue"
          geofence="2 km away"
          onPress={onPress}
        />
        <ClockButton state="on" label="On Shift" timer="2:14:09" haptics={false} />
        <ClockButton state="break" label="Break" />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Outside the venue" }));
    expect(onPress).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "2:14:09, On Shift" }));
  });

  it("shows a shift card with actions", async () => {
    const onPress = vi.fn();
    const { container } = render(
      <ShiftCard
        state="scheduled"
        stateLabel="Scheduled"
        countdown="in 3 h"
        role="Stagehand"
        date="Fri, Nov 3"
        time="6:00 PM to 2:00 AM"
        place="Bayfront Park"
        onPress={onPress}
        actions={<Button label="Swap" />}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Stagehand, Fri, Nov 3, 6:00 PM to 2:00 AM" }),
    );
    expect(onPress).toHaveBeenCalledOnce();
    await expectAccessible(container);
    render(
      <ShiftCard
        state="complete"
        stateLabel="Complete"
        role="Rigger"
        date="Thu"
        time="8 AM"
        place="Hall A"
      />,
    );
  });

  it("shows the offline queue", async () => {
    const onView = vi.fn();
    const { container } = render(
      <OfflineBanner
        message="You're offline"
        queued={3}
        queuedLabel="3 queued"
        viewLabel="View"
        onView={onView}
      />,
    );
    expect(screen.getByRole("img", { name: "3 queued" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(onView).toHaveBeenCalledOnce();
    await expectAccessible(container);
    render(<OfflineBanner message="Offline" queued={0} />);
  });

  it("scans continuously and finishes the batch", async () => {
    const onDone = vi.fn();
    const onModeChange = vi.fn();
    const onNfc = vi.fn();
    const { container } = render(
      <ScanSheet
        mode="receiving"
        modes={[
          { value: "asset", label: "Asset" },
          { value: "receiving", label: "Receiving" },
        ]}
        onModeChange={onModeChange}
        hint="Point at a barcode"
        count={12}
        countLabel="received"
        doneLabel="Review Batch"
        onDone={onDone}
        last={{ ok: true, title: "Case 14", code: "00012345678905" }}
        nfc={{ label: "Read NFC", onPress: onNfc }}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Asset" }));
    fireEvent.click(screen.getByRole("button", { name: "Read NFC" }));
    fireEvent.click(screen.getByRole("button", { name: "Review Batch" }));
    expect(onModeChange).toHaveBeenCalledWith("asset");
    expect([onNfc, onDone].map((f) => f.mock.calls.length)).toEqual([1, 1]);
    expect(screen.getByRole("group", { name: "12 received" })).toBeTruthy();
    await expectAccessible(container);
    render(
      <ScanSheet
        mode="asset"
        hint="h"
        count={0}
        countLabel="scanned"
        doneLabel="Done"
        onDone={onDone}
        last={{ ok: false, title: "Unknown code", code: "1" }}
      />,
    );
  });

  it("keeps either side of a sync conflict", async () => {
    const mine = vi.fn();
    const theirs = vi.fn();
    const { container } = render(
      <SyncConflictSheet
        message="This changed on the server while you were offline."
        field="Count"
        mine="24"
        mineMeta="2:10 PM"
        theirs="22"
        theirsMeta="2:12 PM"
        onKeepMine={mine}
        onKeepTheirs={theirs}
        labels={{
          mine: "Yours",
          theirs: "Server",
          keepMine: "Keep Mine",
          keepTheirs: "Keep Server",
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Keep Mine" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep Server" }));
    expect([mine, theirs].map((f) => f.mock.calls.length)).toEqual([1, 1]);
    await expectAccessible(container);
  });

  it("walks the three incident steps with hold to confirm for critical types", async () => {
    const onSelectType = vi.fn();
    const onSubmit = vi.fn();
    const onChangeLocation = vi.fn();
    const props = {
      types: [
        { key: "medical", label: "Medical", icon: "HeartPulse", critical: true },
        { key: "spill", label: "Spill", icon: "Droplets" },
      ],
      location: "Gate B",
      onChangeLocation,
      onSelectType,
      submitLabel: "Send Report",
      holdHint: "Hold to send",
      onSubmit,
      labels: { step: "Step 1 of 3", location: "Location", change: "Change" },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { container, rerender } = render(
      <QuickIncidentSheet {...props} step={1} selected="spill" />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Medical" }));
    expect(onSelectType).toHaveBeenCalledWith("medical");
    await expectAccessible(container);
    rerender(<QuickIncidentSheet {...props} step={2} selected="medical" />);
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(onChangeLocation).toHaveBeenCalledOnce();
    rerender(
      <QuickIncidentSheet
        {...props}
        step={3}
        selected="medical"
        attachments={<Text>Photos</Text>}
      />,
    );
    const send = screen.getByRole("button", { name: "Send Report" });
    fireEvent.click(send);
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.contextMenu(send);
    expect(onSubmit).toHaveBeenCalledOnce();
    rerender(<QuickIncidentSheet {...props} step={3} selected="spill" />);
    fireEvent.click(screen.getByRole("button", { name: "Send Report" }));
    expect(onSubmit).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("runs an inspection item by item", async () => {
    const onResult = vi.fn();
    const onIndexChange = vi.fn();
    const items = [
      { code: "INS-01", label: "Exit signs lit", result: "pass" as const },
      { code: "INS-02", label: "Fire lane clear", help: "Six meters", result: "fail" as const },
    ];
    const labels = {
      pass: "Pass",
      fail: "Fail",
      progress: "2 of 2",
      previous: "Previous",
      next: "Next",
    };
    const { container } = render(
      <ChecklistRunner
        title="Egress walk"
        index={1}
        items={items}
        onResult={onResult}
        onIndexChange={onIndexChange}
        failDetail={<Text>Add a photo</Text>}
        labels={labels}
      />,
    );
    expect(screen.getByText("Add a photo")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
    fireEvent.click(screen.getByRole("button", { name: "Pass" }));
    expect(onResult).toHaveBeenCalledWith("INS-02", "pass");
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(onIndexChange).toHaveBeenCalledWith(0);
    await expectAccessible(container);
    render(
      <ChecklistRunner title="Empty" index={0} items={[]} onResult={onResult} labels={labels} />,
    );
  });
});
