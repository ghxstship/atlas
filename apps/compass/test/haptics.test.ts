import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
vi.mock("expo-haptics", () => ({
  NotificationFeedbackType: { Success: "success", Warning: "warning" },
  ImpactFeedbackStyle: { Medium: "medium" },
  selectionAsync: () => (calls.push("selection"), Promise.resolve()),
  notificationAsync: (type: string) => (calls.push(`notification:${type}`), Promise.resolve()),
  impactAsync: (style: string) => (calls.push(`impact:${style}`), Promise.resolve()),
}));

const { hapticCall, playHaptic } = await import("../src/runtime/haptics");

describe("ThemeProvider onHaptic on expo-haptics", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("maps every design-system haptic kind to an expo-haptics call", async () => {
    for (const kind of ["selection", "success", "warning", "impact"] as const)
      await hapticCall(kind)();
    expect(calls).toEqual([
      "selection",
      "notification:success",
      "notification:warning",
      "impact:medium",
    ]);
  });

  it("plays without waiting for the device", () => {
    playHaptic("impact");
    expect(calls).toEqual(["impact:medium"]);
  });
});
