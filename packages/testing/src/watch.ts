/**
 * The in-page half of `watchFor` (src/playwright.ts), kept apart from Playwright so the unit tests can run it
 * against a fake page.
 */
import type { VisibleProbe } from "./interaction.ts";

/**
 * Watches the page for a visible state (Section 11.10 rule 9), from inside the browser so the measure carries no
 * round trip to the test runner. With `afterInput`, the watch notes the first pointer or key press and counts the
 * state only from then on; with `after`, it notes the first moment that other state holds instead. The states are
 * checked on every animation frame and on every DOM change, and their first moments kept. Returns whether the state
 * the watch starts from (`after`, or else `probe`) already holds. Runs in the browser; typed loosely because this
 * package compiles without the DOM library, and it refers to nothing outside its own body, since `watchFor` sends
 * its source to the page.
 */
export function installWatch(
  id: string,
  probe: VisibleProbe,
  afterInput: boolean,
  after: VisibleProbe | null,
  holds: (probe: VisibleProbe, root: unknown) => boolean,
): boolean {
  const win = globalThis as unknown as {
    document: unknown;
    performance: { now(): number; timeOrigin: number };
    requestAnimationFrame(callback: () => void): number;
    addEventListener(type: string, listener: () => void, options: object): void;
    removeEventListener(type: string, listener: () => void, options: object): void;
    MutationObserver: new (callback: () => void) => {
      observe(target: unknown, options: object): void;
      disconnect(): void;
    };
    __xosWatches?: Record<string, { inputAt: number | null; seenAt: number | null }>;
  };
  const now = () => win.performance.timeOrigin + win.performance.now();
  const before = holds(after ?? probe, win.document);
  const state: { inputAt: number | null; seenAt: number | null } = {
    inputAt: afterInput || after ? null : now(),
    seenAt: null,
  };
  win.__xosWatches = { ...win.__xosWatches, [id]: state };
  const options = { capture: true };
  const onInput = () => {
    if (state.inputAt === null) state.inputAt = now();
  };
  const observer = new win.MutationObserver(() => check());
  const stop = () => {
    observer.disconnect();
    win.removeEventListener("pointerdown", onInput, options);
    win.removeEventListener("keydown", onInput, options);
  };
  const check = () => {
    if (state.seenAt !== null) return;
    if (state.inputAt === null && after && holds(after, win.document)) state.inputAt = now();
    if (state.inputAt === null) return;
    if (holds(probe, win.document)) {
      state.seenAt = now();
      stop();
    }
  };
  const frame = () => {
    check();
    if (state.seenAt === null) win.requestAnimationFrame(frame);
  };
  if (afterInput && !after) {
    win.addEventListener("pointerdown", onInput, options);
    win.addEventListener("keydown", onInput, options);
  }
  observer.observe(win.document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  win.requestAnimationFrame(frame);
  return before;
}
