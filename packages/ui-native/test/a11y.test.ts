import { AccessibilityInfo } from "react-native";
import { afterEach, describe, expect, it, vi } from "vitest";
import { announce } from "../src/index.ts";

describe("announce (WCAG 4.1.3 status messages)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("speaks the message through the platform screen reader", () => {
    const spy = vi.spyOn(AccessibilityInfo, "announceForAccessibility");
    announce("  Asset RAD-001 checked out  ");
    expect(spy).toHaveBeenCalledWith("Asset RAD-001 checked out");
  });

  it("ignores empty messages", () => {
    const spy = vi.spyOn(AccessibilityInfo, "announceForAccessibility");
    announce("");
    announce("   ");
    announce(null);
    announce(undefined);
    expect(spy).not.toHaveBeenCalled();
  });
});
