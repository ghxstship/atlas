import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  probeHolds,
  type ProbeElement,
  type ProbeRoot,
  type VisibleProbe,
} from "../src/interaction.ts";
import { installWatch } from "../src/watch.ts";

type Holds = (probe: VisibleProbe, root: unknown) => boolean;
type WatchState = { inputAt: number | null; seenAt: number | null };

/**
 * A fake page for the watch: a document of buttons whose labels the test sets, a clock it moves, animation frames it
 * runs one at a time, a DOM change it reports, and the input listeners the watch adds.
 */
function fakePage() {
  const labels: string[] = [];
  let clock = 0;
  let frames: Array<() => void> = [];
  const listeners = new Map<string, () => void>();
  const observers: Array<{ callback: () => void; observing: boolean }> = [];
  const button = (text: string): ProbeElement => ({
    textContent: text,
    getBoundingClientRect: () => ({ width: 120, height: 24 }),
  });
  const document: ProbeRoot = {
    querySelectorAll: (selector) => (selector === "button" ? labels.map(button) : []),
    defaultView: null,
  };
  const win = {
    document,
    performance: { timeOrigin: 1_000, now: () => clock },
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
    removeEventListener: (type: string, listener: () => void) => {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    MutationObserver: class {
      private readonly entry: { callback: () => void; observing: boolean };
      constructor(callback: () => void) {
        this.entry = { callback, observing: false };
        observers.push(this.entry);
      }
      observe() {
        this.entry.observing = true;
      }
      disconnect() {
        this.entry.observing = false;
      }
    },
  };
  for (const [key, value] of Object.entries(win)) vi.stubGlobal(key, value);
  return {
    listeners,
    /** Shows these labels from now on. */
    show(...next: string[]) {
      labels.splice(0, labels.length, ...next);
    },
    /** Moves the clock to `at` milliseconds after the page's time origin. */
    at(ms: number) {
      clock = ms;
    },
    /** Runs the frames requested so far, as the browser does on its next paint. */
    paint() {
      const due = frames;
      frames = [];
      for (const callback of due) callback();
    },
    /** Reports a DOM change to every observer still observing. */
    mutate() {
      for (const entry of observers) if (entry.observing) entry.callback();
    },
    observing: () => observers.some((entry) => entry.observing),
    pendingFrames: () => frames.length,
    state: (id: string): WatchState => {
      const watches = (globalThis as unknown as { __xosWatches?: Record<string, WatchState> })
        .__xosWatches;
      const state = watches?.[id];
      if (!state) throw new Error(`No watch ${id} on the page.`);
      return state;
    },
  };
}

/** The watch rebuilt from its source, as `watchFor` sends it to the page: a free variable would be undefined there. */
function install(id: string, probe: VisibleProbe, afterInput: boolean, after: VisibleProbe | null) {
  const rebuilt = new Function(`return (${installWatch.toString()})`)() as typeof installWatch;
  const holds = new Function(`return (${probeHolds.toString()})`)() as Holds;
  return rebuilt(id, probe, afterInput, after, holds);
}

const pin = { selector: "button", text: "Pin page" };
const unpin = { selector: "button", text: "Unpin page" };

beforeEach(() => {
  vi.stubGlobal("__xosWatches", undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("installWatch with `after`", () => {
  it("counts the state only once the other state has held, and adds no input listeners", () => {
    const page = fakePage();
    page.show("Pin page");
    // The label it watches for holds already; the watch starts from Unpin page, which does not.
    expect(install("w1", pin, true, unpin)).toBe(false);
    expect(page.listeners.size).toBe(0);

    page.at(5);
    page.paint();
    page.mutate();
    expect(page.state("w1")).toEqual({ inputAt: null, seenAt: null });

    page.at(40);
    page.show("Unpin page");
    page.mutate();
    expect(page.state("w1")).toEqual({ inputAt: 1_040, seenAt: null });

    page.at(90);
    page.paint();
    expect(page.state("w1").seenAt).toBeNull();

    page.at(120);
    page.show("Pin page");
    page.paint();
    expect(page.state("w1")).toEqual({ inputAt: 1_040, seenAt: 1_120 });
    // Seen once: the watch stops observing and asks for no more frames.
    expect(page.observing()).toBe(false);
    expect(page.pendingFrames()).toBe(0);
  });

  it("arms and sees in one check when both states hold in the same frame", () => {
    const page = fakePage();
    install("w1", pin, true, unpin);
    page.at(30);
    // Text matches as written: "Unpin page" holds "pin page", not "Pin page", so only the second button is Pin page.
    page.show("Unpin page", "Pin page");
    page.paint();
    expect(page.state("w1")).toEqual({ inputAt: 1_030, seenAt: 1_030 });
  });

  it("answers that the starting state holds already, so watchFor can refuse the watch", () => {
    const page = fakePage();
    page.show("Unpin page");
    expect(install("w1", pin, true, unpin)).toBe(true);
  });
});

describe("installWatch with input", () => {
  it("counts the state only after a pointer or key press, then removes its listeners", () => {
    const page = fakePage();
    expect(install("w1", unpin, true, null)).toBe(false);
    expect([...page.listeners.keys()].sort()).toEqual(["keydown", "pointerdown"]);

    page.at(10);
    page.show("Unpin page");
    page.paint();
    expect(page.state("w1")).toEqual({ inputAt: null, seenAt: null });

    page.show("Pin page");
    page.at(20);
    page.listeners.get("pointerdown")?.();
    page.at(25);
    page.listeners.get("keydown")?.();
    expect(page.state("w1").inputAt).toBe(1_020);

    page.at(70);
    page.show("Unpin page");
    page.mutate();
    expect(page.state("w1")).toEqual({ inputAt: 1_020, seenAt: 1_070 });
    expect(page.listeners.size).toBe(0);
    expect(page.observing()).toBe(false);
  });

  it("starts the clock at once without input, and keeps each watch's state apart", () => {
    const page = fakePage();
    page.at(3);
    expect(install("w1", unpin, false, null)).toBe(false);
    expect(install("w2", pin, false, null)).toBe(false);
    expect(page.listeners.size).toBe(0);
    expect(page.state("w1")).toEqual({ inputAt: 1_003, seenAt: null });

    page.at(8);
    page.show("Pin page");
    page.paint();
    expect(page.state("w1").seenAt).toBeNull();
    expect(page.state("w2")).toEqual({ inputAt: 1_003, seenAt: 1_008 });
  });
});
