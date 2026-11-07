import { describe, expect, it } from "vitest";
import {
  acknowledgmentBudgetMs,
  describeTiming,
  latencyOf,
  probeHolds,
  workflowTargets,
  type ProbeElement,
  type ProbeRoot,
} from "../src/interaction.ts";

interface FakeElement extends ProbeElement {
  readonly matches: string;
  readonly visibility?: string;
  readonly opacity?: string;
}

function element(
  matches: string,
  text: string,
  size: [number, number] = [120, 24],
  style: { visibility?: string; opacity?: string } = {},
): FakeElement {
  return {
    matches,
    textContent: text,
    getBoundingClientRect: () => ({ width: size[0], height: size[1] }),
    ...style,
  };
}

/** A document of flat elements, each answering one selector. */
function root(elements: FakeElement[], withView = true): ProbeRoot {
  return {
    querySelectorAll: (selector) => elements.filter((e) => e.matches === selector),
    defaultView: withView
      ? {
          getComputedStyle: (e) => ({
            visibility: (e as FakeElement).visibility ?? "visible",
            opacity: (e as FakeElement).opacity ?? "1",
          }),
        }
      : null,
  };
}

describe("budgets", () => {
  it("carry Section 11.10 rule 9 and the Section 11.11 targets", () => {
    expect(acknowledgmentBudgetMs).toBe(100);
    expect(workflowTargets).toEqual({
      projectFromTemplateMs: 60_000,
      gateReadinessMs: 500,
      keyboardCreateMs: 10_000,
      cueSyncMs: 500,
    });
  });
});

describe("probeHolds", () => {
  it("finds a visible element by selector and text, whatever its spacing", () => {
    const doc = root([element("button", "  Unpin\n page ")]);
    expect(probeHolds({ selector: "button", text: "Unpin page" }, doc)).toBe(true);
    expect(probeHolds({ selector: "button" }, doc)).toBe(true);
    expect(probeHolds({ selector: "button", text: "Pin this" }, doc)).toBe(false);
    expect(probeHolds({ selector: "a" }, doc)).toBe(false);
  });

  it("does not count what a person cannot see", () => {
    const screenReaderOnly = root([element("p", "Saved.", [1, 1])]);
    expect(probeHolds({ selector: "p", text: "Saved." }, screenReaderOnly)).toBe(false);
    const hidden = root([element("p", "Saved.", [80, 20], { visibility: "hidden" })]);
    expect(probeHolds({ selector: "p" }, hidden)).toBe(false);
    const transparent = root([element("p", "Saved.", [80, 20], { opacity: "0" })]);
    expect(probeHolds({ selector: "p" }, transparent)).toBe(false);
  });

  it("reads size alone when the document has no view", () => {
    expect(probeHolds({ selector: "p" }, root([element("p", "Saved.")], false))).toBe(true);
    expect(probeHolds({ selector: "p" }, root([element("p", null as unknown as string)]))).toBe(
      true,
    );
  });

  it("holds for an absent state once nothing visible matches", () => {
    expect(probeHolds({ selector: "li", absent: true }, root([]))).toBe(true);
    expect(probeHolds({ selector: "li", absent: true }, root([element("li", "Item")]))).toBe(false);
    expect(
      probeHolds({ selector: "li", text: "Other", absent: true }, root([element("li", "Item")])),
    ).toBe(true);
  });

  it("refers to nothing outside itself, so its source runs in the browser", () => {
    // The Playwright helpers send the function's source to the page; a free variable would be undefined there.
    const rebuilt = new Function(`return (${probeHolds.toString()})`)() as typeof probeHolds;
    expect(
      rebuilt({ selector: "button", text: "Pin" }, root([element("button", "Pin page")])),
    ).toBe(true);
  });
});

describe("timings", () => {
  it("measure from the input to the visible state", () => {
    expect(latencyOf({ inputAt: 1_000, seenAt: 1_042.5 })).toBe(42.5);
    expect(latencyOf({ inputAt: 1_000, seenAt: 999 })).toBe(0);
    expect(() => latencyOf({ inputAt: null, seenAt: 1 })).toThrow(/no pointer or key input/);
  });

  it("say what was measured against which budget", () => {
    expect(describeTiming("Favorite", 41.25, 100)).toBe(
      "Favorite: 41.3 ms, within the 100 ms budget",
    );
    expect(describeTiming("Cue sync", 612, 500)).toBe("Cue sync: 612.0 ms, over the 500 ms budget");
  });
});
