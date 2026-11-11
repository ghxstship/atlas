import { act, fireEvent, render, screen } from "@testing-library/react";
import { expectAccessible } from "./expect-accessible.ts";
import { describe, expect, it, vi } from "vitest";
import { PanResponder } from "react-native";
import {
  Avatar,
  Banner,
  Checkbox,
  CredentialBadge,
  DaySheetView,
  DepartmentChip,
  Dialog,
  EmergencyCodeCard,
  EmptyState,
  ErrorState,
  ForceUpdateScreen,
  InlineAlert,
  LiveActivity,
  Money,
  PhotoCapture,
  ProgressBar,
  QRCode,
  RadioChannelTable,
  RefusalNotice,
  RunOfShowLive,
  Screen,
  SignaturePad,
  Skeleton,
  Switch,
  Text,
  TextField,
  Toast,
  UndoToast,
  UpNextCard,
  resolveStep,
} from "../src/index.ts";

describe("feedback", () => {
  it("renders every tone and runs actions", async () => {
    const onAction = vi.fn();
    const onDismiss = vi.fn();
    const onRetry = vi.fn();
    const { container } = render(
      <div>
        {(["info", "success", "warning", "danger"] as const).map((tone) => (
          <Banner key={tone} tone={tone} message={`${tone} banner`} />
        ))}
        <Banner
          message="Offline mode"
          icon="WifiOff"
          actionLabel="Retry"
          onAction={onAction}
          onDismiss={onDismiss}
          dismissLabel="Dismiss"
        />
        <InlineAlert tone="danger" title="Blocked" message="Permit missing" />
        <InlineAlert message="Saved" />
        <Toast message="Shift saved" actionLabel="View" onAction={onAction} />
        <Toast message="Done" />
        <EmptyState
          sentence="No shifts this week. Ask your lead for one."
          actionLabel="Message Lead"
          icon="Inbox"
          onAction={onAction}
        />
        <EmptyState sentence="Nothing queued." actionLabel="Refresh" />
        <ErrorState
          title="Could not load"
          sentence="Check your signal, then retry."
          actionLabel="Retry"
          reference="REF-42"
          onRetry={onRetry}
        />
        <ErrorState title="Down" sentence="Try later." />
        {(["NO_ANSWER", "UNRATIFIED", "REFUSE"] as const).map((o) => (
          <RefusalNotice
            key={o}
            outcome={o}
            title={o}
            reason="Policy"
            actionLabel="Ask"
            onAction={onAction}
          />
        ))}
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[1] as Element);
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.getByText("NO ANSWER")).toBeTruthy();
    await expectAccessible(container);
  });

  it("counts down Undo and hides it at zero", () => {
    vi.useFakeTimers();
    const onUndo = vi.fn();
    render(<UndoToast message="Task completed" undoLabel="Undo" seconds={2} onUndo={onUndo} />);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onUndo).toHaveBeenCalledOnce();
    try {
      act(() => vi.advanceTimersByTime(1000));
      act(() => vi.advanceTimersByTime(1000));
      expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("forms and data display", () => {
  it("edits fields and toggles controls", async () => {
    const onChangeText = vi.fn();
    const onCheck = vi.fn();
    const onSwitch = vi.fn();
    const { container } = render(
      <div>
        <TextField
          label="Crew name"
          value=""
          onChangeText={onChangeText}
          help="As on your ID"
          autoComplete="name"
        />
        <TextField
          label="Count"
          value="2"
          onChangeText={onChangeText}
          error="Count must be 3 or more"
          keyboard="numeric"
        />
        <TextField label="Notes" value="" onChangeText={onChangeText} multiline disabled secure />
        <Checkbox label="Harness inspected" checked={false} onChange={onCheck} />
        <Checkbox label="Locked" checked disabled onChange={onCheck} />
        <Switch label="Low-data mode" value={false} onChange={onSwitch} help="Fewer photos sync" />
      </div>,
    );
    fireEvent.change(screen.getByLabelText("Crew name"), { target: { value: "Dana" } });
    expect(onChangeText).toHaveBeenCalledWith("Dana");
    fireEvent.click(screen.getByRole("checkbox", { name: "Harness inspected" }));
    expect(onCheck).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("switch", { name: "Low-data mode" }));
    expect(onSwitch).toHaveBeenCalledWith(true);
    expect(screen.getByText("Count must be 3 or more")).toBeTruthy();
    await expectAccessible(container);
  });

  it("formats money and never shows zero for unpriced", () => {
    render(
      <div>
        <Money amount={123456} unpricedLabel="Unpriced" />
        <Money amount={500} currency="JPY" unpricedLabel="Unpriced" />
        <Money amount={null} unpricedLabel="Unpriced" />
      </div>,
    );
    expect(screen.getByText(/1,234\.56/)).toBeTruthy();
    expect(screen.getByText(/500/)).toBeTruthy();
    expect(screen.getByText("Unpriced")).toBeTruthy();
  });
});

describe("data display", () => {
  it("draws avatars, progress, skeletons, QR codes and department chips", async () => {
    const { container } = render(
      <div>
        <Avatar name="Dana Ortiz" />
        <Avatar name="Sam" size="lg" />
        <ProgressBar label="Checklist" value={140} />
        <Skeleton lines={3} />
        <Skeleton width={120} height={20} />
        <QRCode value="NW-CRED-001" label="Badge code" />
        <DepartmentChip code="4000" name="Production" />
      </div>,
    );
    expect(screen.getByRole("img", { name: "Dana Ortiz" }).textContent).toBe("DO");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
    expect(
      screen.getByRole("img", { name: "Badge code" }).querySelector("path")?.getAttribute("d"),
    ).toMatch(/^M\d/);
    expect(screen.getByText("Production")).toBeTruthy();
    await expectAccessible(container);
  });
});

describe("XOS cards", () => {
  it("resolves emergency steps and lists the authorities", async () => {
    const { container } = render(
      <EmergencyCodeCard
        code="Code Red"
        name="Fire"
        swatch="ecode-red"
        domain="Venue"
        recordKey="NW-ECD-1"
        channel="Channel 1"
        steps={["Call {fire}.", "Evacuate by {ems} route.", "Hold {unknown}."]}
        authorities={[{ service: "fire", agency: "Miami Fire Rescue", contact: "911" }]}
        serviceLabels={{ fire: "Fire", ems: "EMS" }}
      />,
    );
    expect(screen.getByText("Call Miami Fire Rescue.")).toBeTruthy();
    expect(screen.getByText("Evacuate by EMS route.")).toBeTruthy();
    expect(screen.getByText("Fire: Miami Fire Rescue · 911")).toBeTruthy();
    expect(resolveStep("{federal}", undefined, undefined)).toBe("{federal}");
    await expectAccessible(container);
  });

  it("sorts the radio plan and shows the live cue", async () => {
    const { container } = render(
      <div>
        <RadioChannelTable
          caption="Radio plan"
          headers={{ zone: "Zone", channel: "Channel", assignment: "Assignment", notes: "Notes" }}
          channels={[
            { zone: 2, channel: 1, assignment: "Security", notes: "" },
            { zone: 1, channel: 3, assignment: "Stage", notes: "Quiet during show" },
          ]}
        />
        <RunOfShowLive
          cues={[
            { number: "Q1", time: "8:00", title: "House to half" },
            { number: "Q2", time: "8:01", title: "Walk-in music out" },
            { number: "Q3", time: "8:02", title: "Lights up" },
          ]}
          current={1}
          nextInSeconds={8}
          nextLabel="Next"
          showMode
        />
        <RunOfShowLive
          cues={[{ number: "Q9", time: "9:00", title: "End" }]}
          current={0}
          nextInSeconds={70}
          nextLabel="Next"
        />
        <RunOfShowLive
          cues={[
            { number: "Q4", time: "9:10", title: "Host welcome" },
            { number: "Q5", time: "9:12", title: "Award one" },
            { number: "Q6", time: "9:20", title: "Headliner" },
          ]}
          current={0}
          next={2}
          nextInSeconds={300}
          countdownText="TBC"
          nextLabel="Standby"
        />
      </div>,
    );
    // After a standby or a jump the next cue is the one named, not the one after the current cue (ADR 0131),
    // and a cue to be confirmed shows TBC in place of the countdown.
    expect(screen.getByText("Standby: Headliner")).toBeTruthy();
    expect(screen.getByText("TBC")).toBeTruthy();
    const items = screen.getAllByRole("listitem");
    expect(items[0]?.getAttribute("aria-label")).toContain("Zone 1");
    expect(screen.getByText("Next: Lights up")).toBeTruthy();
    expect(screen.getByText("0:08")).toBeTruthy();
    await expectAccessible(container);
  });

  it("shows the credential with its QR code", async () => {
    const { container } = render(
      <CredentialBadge
        org="Northwind Live"
        name="Dana Ortiz"
        role="Stage Manager"
        category="All Access"
        categoryColor={3}
        credentialKey="NW-CRD-12"
        payload="signed-payload"
        zones={["Stage", "FOH"]}
        validFrom="Nov 1"
        validTo="Nov 4"
      />,
    );
    expect(screen.getByRole("img", { name: "Dana Ortiz, NW-CRD-12" })).toBeTruthy();
    await expectAccessible(container);
  });
});

describe("screens and Compass layouts", () => {
  it("renders a screen with refresh and footer, and a dialog", async () => {
    const onRefresh = vi.fn();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { container } = render(
      <div>
        <Screen title="Today" onRefresh={onRefresh} footer={<Text>Footer</Text>}>
          <Text>Body</Text>
        </Screen>
        <Screen scroll={false}>
          <Text>Static</Text>
        </Screen>
        <Dialog
          open
          title="Clock out?"
          message="You have 2 tasks open."
          confirmLabel="Clock Out"
          cancelLabel="Stay"
          onConfirm={onConfirm}
          onCancel={onCancel}
          danger
        />
      </div>,
    );
    expect(screen.getByRole("heading", { name: "Today" })).toBeTruthy();
    fireEvent.click(screen.getByText("refresh"));
    fireEvent.click(screen.getByRole("button", { name: "Clock Out" }));
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));
    expect([onRefresh, onConfirm, onCancel].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
    await expectAccessible(container);
    render(
      <Dialog
        open={false}
        title="Hidden"
        message=""
        confirmLabel="Yes"
        cancelLabel="No"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
  });

  it("shows the day sheet and calls a contact", async () => {
    const onCall = vi.fn();
    const { container } = render(
      <DaySheetView
        date="Fri, Nov 3"
        title="Show Day"
        venue="Bayfront Park"
        entries={[
          { time: "4:00 PM", label: "Doors" },
          { time: "6:00 PM", label: "Show", now: true },
        ]}
        contacts={[
          { name: "Dana Ortiz", role: "Stage Manager", onCall },
          { name: "Sam Lee", role: "Production" },
        ]}
        labels={{ schedule: "Schedule", contacts: "Contacts", call: "Call" }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Call Dana Ortiz" }));
    expect(onCall).toHaveBeenCalledOnce();
    await expectAccessible(container);
  });

  it("clears a signature, captures photos and runs the live activity", async () => {
    const onChange = vi.fn();
    const onCapture = vi.fn();
    const onDone = vi.fn();
    const onAnnotate = vi.fn();
    const onToggleBreak = vi.fn();
    const onClockOut = vi.fn();
    const onUpdate = vi.fn();
    const onDirections = vi.fn();
    const { container } = render(
      <div>
        <SignaturePad
          label="Signature"
          attestation="I received 24 cases."
          clearLabel="Clear"
          onChange={onChange}
        />
        <PhotoCapture
          hint="Fit the damage"
          count={2}
          captureLabel="Take photo"
          onCapture={onCapture}
          doneLabel="Done"
          onDone={onDone}
          annotateLabel="Annotate"
          onAnnotate={onAnnotate}
        />
        <PhotoCapture
          hint="h"
          count={0}
          captureLabel="Shoot"
          onCapture={onCapture}
          doneLabel="Finish"
          onDone={onDone}
        />
        <LiveActivity
          label="On Shift"
          elapsed="2:14"
          place="Bayfront Park"
          nextShift="Load Out"
          nextTime="Sat 8 AM"
          labels={{ break: "Break", endBreak: "End Break", clockOut: "Clock Out" }}
          onToggleBreak={onToggleBreak}
          onClockOut={onClockOut}
        />
        <LiveActivity
          label="On Break"
          elapsed="0:05"
          place=""
          nextShift=""
          nextTime=""
          onBreak
          labels={{ break: "Break", endBreak: "End Break", clockOut: "Out" }}
        />
        <ForceUpdateScreen
          message="This version can no longer sync."
          version="4.0.2"
          actionLabel="Update"
          onUpdate={onUpdate}
        />
        <UpNextCard
          org="Northwind Live"
          countdown="in 2 days"
          title="Load In"
          when="Fri 6 AM"
          callTime="5:30 AM"
          address="Bayfront Park"
          parking="Lot C"
          contact="Dana"
          bring={["Gloves", "Badge"]}
          onDirections={onDirections}
          directionsLabel="Directions"
        />
        <UpNextCard org="N" countdown="soon" title="T" when="w" callTime="c" address="a" />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenCalledWith(null);
    fireEvent.click(screen.getByRole("button", { name: "Take photo" }));
    fireEvent.click(screen.getByRole("button", { name: "Annotate" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Break" }));
    fireEvent.click(screen.getByRole("button", { name: "Clock Out" }));
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    fireEvent.click(screen.getByRole("button", { name: "Directions" }));
    expect(
      [onCapture, onAnnotate, onDone, onToggleBreak, onClockOut, onUpdate, onDirections].map(
        (f) => f.mock.calls.length,
      ),
    ).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(screen.getByRole("button", { name: "End Break" })).toBeTruthy();
    await expectAccessible(container);
  });
});

describe("LiveActivity shift card (finding A59-022)", () => {
  const labels = { break: "Break", endBreak: "End Break", clockOut: "Clock Out" };
  it("names the shift being worked, its time and place, under the clock", () => {
    render(
      <LiveActivity
        label="On Shift"
        elapsed="0:12"
        place="You're at Pier Site"
        nextShift="Head Rigger"
        nextTime="7:00 AM to 11:30 PM"
        nextPlace="Venue to be confirmed"
        labels={labels}
      />,
    );
    expect(
      screen.getByLabelText("Head Rigger, 7:00 AM to 11:30 PM, Venue to be confirmed"),
    ).toBeTruthy();
    expect(screen.getByText("Venue to be confirmed")).toBeTruthy();
  });

  it("leaves the card out when there is no shift to name, never an empty square", () => {
    render(
      <LiveActivity
        label="On Shift"
        elapsed="0:12"
        place=""
        nextShift=""
        nextTime=""
        labels={labels}
      />,
    );
    expect(screen.getAllByLabelText(/^On Shift, 0:12/)).toHaveLength(1);
    expect(screen.queryAllByLabelText(/^, |^$/)).toHaveLength(0);
  });
});

describe("SignaturePad inside a scrolling form (simulator defect)", () => {
  it("keeps the stroke from the scroll view and still counts a stroke that is taken", () => {
    const create = vi.spyOn(PanResponder, "create");
    const onChange = vi.fn();
    render(
      <SignaturePad label="Signature" attestation="True." clearLabel="Clear" onChange={onChange} />,
    );
    const config = create.mock.calls.at(-1)?.[0] as unknown as Record<
      string,
      (...a: unknown[]) => unknown
    >;
    const at = (x: number, y: number) => ({ nativeEvent: { locationX: x, locationY: y } });
    expect(config["onPanResponderTerminationRequest"]?.()).toBe(false);
    act(() => {
      config["onPanResponderGrant"]?.(at(10, 10));
      config["onPanResponderMove"]?.(at(60, 20));
      config["onPanResponderTerminate"]?.();
    });
    expect(onChange).toHaveBeenLastCalledWith("M10.0 10.0L60.0 20.0");
    create.mockRestore();
  });
});
