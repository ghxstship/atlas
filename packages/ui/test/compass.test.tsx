import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  Button,
  ChecklistRunner,
  ClockButton,
  DaySheetView,
  ForceUpdateScreen,
  LiveActivity,
  OfflineBanner,
  PhotoCapture,
  QuickIncidentSheet,
  ScanSheet,
  ShiftCard,
  SignaturePad,
  SyncConflictSheet,
} from "../src/index.ts";
import { expectAccessible } from "./a11y.ts";

describe("ClockButton", () => {
  it("shows the geofence before the tap and clocks in", async () => {
    const onClick = vi.fn();
    const { container } = render(
      <ClockButton
        state="out"
        label="Clock In"
        detail="Shift starts 6:00 PM"
        geofence="You're at the venue"
        geofenceOk
        onClick={onClick}
      />,
    );
    expect(screen.getByText("You're at the venue")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Clock In/ }));
    expect(onClick).toHaveBeenCalledOnce();
    await expectAccessible(container);
  });

  it("refuses the tap when blocked and shows the timer when on shift", async () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <ClockButton state="blocked" label="Outside the venue" onClick={onClick} />,
    );
    const button = screen.getByRole("button");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    rerender(<ClockButton state="on" label="On Shift" timer="02:14:09" geofence="Off site" />);
    expect(screen.getByText("02:14:09")).toBeTruthy();
  });
});

describe("ScanSheet", () => {
  it("switches mode, reports the last scan and finishes", async () => {
    const onModeChange = vi.fn();
    const onDone = vi.fn();
    const onNfc = vi.fn();
    const { container } = render(
      <ScanSheet
        frame
        mode="receiving"
        hint="Point at a barcode"
        count={12}
        countLabel="received"
        doneLabel="Review Batch"
        last={{ ok: false, title: "Unknown code", code: "0012345678905" }}
        onModeChange={onModeChange}
        onDone={onDone}
        onNfc={onNfc}
        camera={<span>Feed</span>}
      />,
    );
    await userEvent.click(screen.getByRole("radio", { name: "Asset" }));
    expect(onModeChange).toHaveBeenCalledWith("asset");
    await userEvent.click(screen.getByRole("button", { name: "Read NFC" }));
    expect(onNfc).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Review Batch" }));
    expect(onDone).toHaveBeenCalledOnce();
    expect(screen.getByText("Unknown code")).toBeTruthy();
    expect(screen.getByText("Feed")).toBeTruthy();
    await expectAccessible(container);
  });
});

describe("OfflineBanner", () => {
  it("shows the queue count and opens the queue", async () => {
    const onView = vi.fn();
    const { container, rerender } = render(
      <OfflineBanner message="You're offline" queued={3} onView={onView} />,
    );
    expect(screen.getByText("3 queued")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "View" }));
    expect(onView).toHaveBeenCalledOnce();
    await expectAccessible(container);
    rerender(<OfflineBanner message="You're offline" queued={0} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("QuickIncidentSheet", () => {
  it("offers the type grid with critical types marked", async () => {
    const onSelect = vi.fn();
    const { container } = render(
      <QuickIncidentSheet
        frame
        location="Gate B, North Lot"
        types={[
          { label: "Medical", icon: "HeartPulse", critical: true },
          { label: "Spill", icon: "Droplets" },
        ]}
        onSelect={onSelect}
      />,
    );
    expect(screen.getByRole("dialog", { name: "Report Incident" })).toBeTruthy();
    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Spill" }));
    expect(onSelect).toHaveBeenCalledWith("Spill");
    await expectAccessible(container);
  });
});

describe("ChecklistRunner", () => {
  const items = [
    { code: "INS-01", label: "Exit signs lit", result: "pass" as const },
    { code: "INS-02", label: "Fire lane clear", help: "Six meters", result: null },
  ];

  it("records Pass and asks for a photo and note on Fail", async () => {
    const onResult = vi.fn();
    const onAddPhoto = vi.fn();
    const onNoteChange = vi.fn();
    const { container } = render(
      <ChecklistRunner
        frame
        title="Egress walk"
        index={1}
        items={items}
        onResult={onResult}
        onAddPhoto={onAddPhoto}
        onNoteChange={onNoteChange}
      />,
    );
    expect(screen.getByText("2 of 2")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
    await userEvent.click(screen.getByRole("button", { name: "Fail" }));
    expect(onResult).toHaveBeenCalledWith("INS-02", "fail");
    expect(screen.getByRole("button", { name: "Fail" }).getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "Add Photo" }));
    expect(onAddPhoto).toHaveBeenCalledWith("INS-02");
    await userEvent.type(screen.getByLabelText("What failed?"), "B");
    expect(onNoteChange).toHaveBeenCalledWith("INS-02", "B");
    await expectAccessible(container);
    await userEvent.click(screen.getByRole("button", { name: "Pass" }));
    expect(onResult).toHaveBeenLastCalledWith("INS-02", "pass");
    expect(screen.queryByLabelText("What failed?")).toBeNull();
  });

  it("renders the header alone when the index is past the end", () => {
    render(<ChecklistRunner title="Empty" index={0} items={[]} />);
    expect(screen.getByText("1 of 0")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pass" }));
  });
});

describe("ShiftCard and DaySheetView", () => {
  it("shows the shift facts and actions", async () => {
    const { container } = render(
      <ShiftCard
        state="scheduled"
        stateLabel="Scheduled"
        countdown="in 3 h"
        role="Stagehand"
        date="Fri, Nov 3"
        time="6:00 PM to 2:00 AM"
        place="Bayfront Park"
        actions={<Button>Swap</Button>}
      />,
    );
    expect(screen.getByText("Stagehand")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Swap" })).toBeTruthy();
    await expectAccessible(container);
  });

  it("marks the current entry and calls a contact", async () => {
    const onCall = vi.fn();
    const onMessage = vi.fn();
    const { container } = render(
      <DaySheetView
        frame
        date="Fri, Nov 3"
        title="Show Day"
        venue="Bayfront Park"
        entries={[
          { time: "4:00 PM", label: "Doors" },
          { time: "6:00 PM", label: "Show", now: true },
        ]}
        contacts={[{ name: "Dana Ortiz", role: "Stage Manager" }]}
        onCall={onCall}
        onMessage={onMessage}
      />,
    );
    expect(screen.getByText("Now")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Call Dana Ortiz" }));
    expect(onCall).toHaveBeenCalledWith("Dana Ortiz");
    await userEvent.click(screen.getByRole("button", { name: "Message Dana Ortiz" }));
    expect(onMessage).toHaveBeenCalledWith("Dana Ortiz");
    await expectAccessible(container);
  });
});

describe("SignaturePad", () => {
  it("clears and reports null", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <SignaturePad
        label="Signature"
        attestation="I confirm the count is correct."
        onChange={onChange}
      />,
    );
    expect(screen.getByRole("img", { name: /Signature area/ })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenCalledWith(null);
    await expectAccessible(container);
  });
});

describe("PhotoCapture, LiveActivity and ForceUpdateScreen", () => {
  it("takes photos and finishes", async () => {
    const onCapture = vi.fn();
    const onDone = vi.fn();
    const onAnnotate = vi.fn();
    const { container } = render(
      <PhotoCapture
        frame
        hint="Fit the damage in frame"
        count={2}
        onCapture={onCapture}
        onDone={onDone}
        onAnnotate={onAnnotate}
      />,
    );
    expect(screen.getByRole("img", { name: "Photo 2" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Take photo" }));
    await userEvent.click(screen.getByRole("button", { name: "Annotate" }));
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect([onCapture, onAnnotate, onDone].every((f) => f.mock.calls.length === 1)).toBe(true);
    await expectAccessible(container);
  });

  it("switches Break to End Break and clocks out", async () => {
    const onToggleBreak = vi.fn();
    const onClockOut = vi.fn();
    const { container, rerender } = render(
      <LiveActivity
        label="On Shift"
        elapsed="2:14"
        place="Bayfront Park"
        nextShift="Load Out"
        nextTime="Sat 8:00 AM"
        onToggleBreak={onToggleBreak}
        onClockOut={onClockOut}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Break" }));
    await userEvent.click(screen.getByRole("button", { name: "Clock Out" }));
    expect(onToggleBreak).toHaveBeenCalledOnce();
    expect(onClockOut).toHaveBeenCalledOnce();
    await expectAccessible(container);
    rerender(
      <LiveActivity label="On Break" elapsed="0:05" place="" nextShift="" nextTime="" onBreak />,
    );
    expect(screen.getByRole("button", { name: "End Break" })).toBeTruthy();
  });

  it("asks for the update", async () => {
    const onUpdate = vi.fn();
    const { container } = render(
      <ForceUpdateScreen
        frame
        message="This version can no longer sync."
        version="4.0.2 or later"
        onUpdate={onUpdate}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(onUpdate).toHaveBeenCalledOnce();
    await expectAccessible(container);
  });
});

describe("SyncConflictSheet", () => {
  it("keeps the chosen value", async () => {
    const onKeep = vi.fn();
    const { container } = render(
      <SyncConflictSheet
        frame
        message="This changed on the server while you were offline."
        field="Count"
        mine="24"
        mineMeta="2:10 PM"
        theirs="22"
        theirsMeta="2:12 PM"
        onKeep={onKeep}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Keep Selected" }));
    expect(onKeep).toHaveBeenLastCalledWith("mine");
    await userEvent.click(screen.getByRole("radio", { name: /Saved on Server/ }));
    await userEvent.click(screen.getByRole("button", { name: "Keep Selected" }));
    expect(onKeep).toHaveBeenLastCalledWith("theirs");
    await expectAccessible(container);
  });
});
