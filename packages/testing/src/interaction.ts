/**
 * Interaction timing for the journeys: the 100 ms acknowledgment of Section 11.10 rule 9 and the measured
 * targets of the Section 11.11 workflow table, with the visible-state probe the Playwright helpers watch for
 * (src/playwright.ts).
 */

/** Section 11.10 rule 9 and Section 11.2: every action acknowledges within 100 ms. */
export const acknowledgmentBudgetMs = 100;

/** The timed targets of the Section 11.11 workflow table that a journey measures. */
export const workflowTargets = {
  /** Projects and gates: a new project from a template. */
  projectFromTemplateMs: 60_000,
  /** Projects and gates: gate readiness loads. */
  gateReadinessMs: 500,
  /** Work and records: create and fully classify a record, keyboard only. */
  keyboardCreateMs: 10_000,
  /** Show: a called cue reaches every connected device. */
  cueSyncMs: 500,
} as const;

/**
 * A visible state, described as data so it can be checked inside the page on every frame: an element matching
 * `selector` that is rendered with a size (a screen-reader-only element does not count), whose text contains
 * `text` when given. With `absent`, the state is that no such element is visible.
 */
export interface VisibleProbe {
  readonly selector: string;
  readonly text?: string;
  readonly absent?: boolean;
}

/** The parts of an element the probe reads; a DOM element has them all. */
export interface ProbeElement {
  readonly textContent: string | null;
  getBoundingClientRect(): { readonly width: number; readonly height: number };
}

/** The parts of a document the probe reads, with the computed visibility of an element. */
export interface ProbeRoot {
  querySelectorAll(selector: string): ArrayLike<ProbeElement>;
  readonly defaultView: {
    getComputedStyle(element: ProbeElement): {
      readonly visibility: string;
      readonly opacity: string;
    };
  } | null;
}

/**
 * Whether the probe's state holds in `root`. It runs inside the page as well as in Node, so it refers to nothing
 * outside its own body: the Playwright helpers send its source to the browser.
 */
export function probeHolds(probe: VisibleProbe, root: ProbeRoot): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const wanted = probe.text === undefined ? null : normalize(probe.text);
  const found = Array.from(root.querySelectorAll(probe.selector)).some((element) => {
    // A screen-reader-only element is clipped to a pixel: what a person sees has a real size.
    const box = element.getBoundingClientRect();
    if (box.width <= 1 || box.height <= 1) return false;
    const style = root.defaultView?.getComputedStyle(element);
    if (style && (style.visibility === "hidden" || Number(style.opacity) === 0)) return false;
    return wanted === null || normalize(element.textContent ?? "").includes(wanted);
  });
  return probe.absent ? !found : found;
}

/** One measured interaction: when the input happened and when the state became visible, in epoch milliseconds. */
export interface InteractionTiming {
  /** The first pointer press or key press after the watch began; null for a watch that takes no input. */
  readonly inputAt: number | null;
  /** The first frame, or DOM change, at which the probe held. */
  readonly seenAt: number;
}

/** Milliseconds from the input to the visible state; a watch without input has no latency to report. */
export function latencyOf(timing: InteractionTiming): number {
  if (timing.inputAt === null) throw new Error("The watch saw no pointer or key input.");
  return Math.max(0, timing.seenAt - timing.inputAt);
}

/** The sentence an assertion fails with: what was measured against which budget. */
export function describeTiming(label: string, elapsedMs: number, budgetMs: number): string {
  const verdict = elapsedMs <= budgetMs ? "within" : "over";
  return `${label}: ${elapsedMs.toFixed(1)} ms, ${verdict} the ${budgetMs} ms budget`;
}
