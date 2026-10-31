import { describe, expect, it } from "vitest";
import { focusAfterLeaving } from "@/components/home/fyi-focus";

/**
 * A127: when a For Your Information item is marked Done or snoozed, the item that takes its place takes the focus, so
 * a run of E clears the list. Once the last one leaves, nothing is left to focus and the empty-state sentence takes it.
 */
describe("focusAfterLeaving", () => {
  it("moves to the item that takes the place of the one that left", () => {
    expect(focusAfterLeaving(0, 3)).toBe(0);
    expect(focusAfterLeaving(1, 3)).toBe(1);
  });

  it("moves back one when the last item in the list left", () => {
    expect(focusAfterLeaving(2, 3)).toBe(1);
    expect(focusAfterLeaving(1, 2)).toBe(0);
  });

  it("hands the focus to the empty-state sentence once the only item leaves", () => {
    expect(focusAfterLeaving(0, 1)).toBeNull();
  });

  it("clears a whole list with a run of E from the top", () => {
    let count = 4;
    let index: number | null = 0;
    const focused: (number | null)[] = [];
    while (index !== null) {
      index = focusAfterLeaving(index, count);
      count -= 1;
      focused.push(index);
    }
    expect(focused).toEqual([0, 0, 0, null]);
    expect(count).toBe(0);
  });
});
