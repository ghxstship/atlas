import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RunOfShowLive, Sheet, useReducedMotion } from "../src/index.ts";
import { setReduceMotionForTest } from "./shims/react-native.tsx";
import { expectAccessible } from "./expect-accessible.ts";

function MotionProbe() {
  return <p>{useReducedMotion() ? "still" : "moving"}</p>;
}

describe("A23-008: Reduce Motion", () => {
  it("follows the system setting and its change event", async () => {
    render(<MotionProbe />);
    expect(screen.getByText("moving")).toBeTruthy();
    act(() => setReduceMotionForTest(true));
    expect(screen.getByText("still")).toBeTruthy();
    act(() => setReduceMotionForTest(false));
    expect(screen.getByText("moving")).toBeTruthy();
  });

  it("fades a sheet in instead of sliding it while Reduce Motion is on", () => {
    const sheet = (
      <Sheet open title="Report" onClose={() => undefined} closeLabel="Close" testID="sheet">
        <p>Body</p>
      </Sheet>
    );
    const { rerender } = render(sheet);
    const modal = () => screen.getByTestId("sheet").closest("[data-animation]");
    expect(modal()?.getAttribute("data-animation")).toBe("slide");
    act(() => setReduceMotionForTest(true));
    rerender(sheet);
    expect(modal()?.getAttribute("data-animation")).toBe("fade");
    act(() => setReduceMotionForTest(false));
  });
});

describe("A23-009: the run of show countdown is not a live region", () => {
  it("keeps only the next cue live and labels the countdown for speech", async () => {
    const { container } = render(
      <RunOfShowLive
        cues={[
          { number: "Q1", time: "8:00", title: "House to half" },
          { number: "Q2", time: "8:02", title: "Doors" },
        ]}
        current={0}
        nextInSeconds={130}
        nextLabel="Next"
        countdownLabel="2 min 10 s to Doors"
      />,
    );
    const live = container.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toBe("Next: Doors");
    expect(live?.textContent).not.toContain("2:10");
    expect(screen.getByLabelText("2 min 10 s to Doors").textContent).toBe("2:10");
    await expectAccessible(container);
  });
});
