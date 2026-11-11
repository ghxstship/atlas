/**
 * The gallery's fixed clock (A141). No component reads the time of day: every time, timer and countdown
 * the gallery shows is a fixture string or number. The one clock a component keeps itself is UndoToast's
 * one-second countdown, so while the gallery is open timers of a second or longer are held and never
 * fire, and every countdown shows its first value however long the snapshot waits. Shorter timers, which
 * React and React Native use to render, run as usual.
 *
 * Holds nest: the clock runs again when the last holder releases it.
 */

/** Timers this long or longer are held while the clock is held. */
export const HELD_TIMER_MS = 1000;

type TimerFn = (
  handler: (...args: unknown[]) => void,
  timeout?: number,
  ...args: unknown[]
) => unknown;
type ClearFn = (id: unknown) => void;

interface Saved {
  setTimeout: TimerFn;
  setInterval: TimerFn;
  clearTimeout: ClearFn;
  clearInterval: ClearFn;
}

const timers = globalThis as unknown as Saved;
let holders = 0;
let saved: Saved | null = null;
/** Ids handed out for held timers; they never collide with a real timer's id. */
let heldId = 0;
const held = new Set<number>();

function holding(real: TimerFn): TimerFn {
  return (handler, timeout, ...args) => {
    if ((timeout ?? 0) >= HELD_TIMER_MS) {
      heldId -= 1;
      held.add(heldId);
      return heldId;
    }
    return real(handler, timeout, ...args);
  };
}

function clearing(real: ClearFn): ClearFn {
  return (id) => {
    if (typeof id === "number" && held.delete(id)) return;
    real(id);
  };
}

/** Holds the clock until the returned function is called; calling that function twice is harmless. */
export function holdClock(): () => void {
  holders += 1;
  if (saved === null) {
    saved = {
      setTimeout: timers.setTimeout,
      setInterval: timers.setInterval,
      clearTimeout: timers.clearTimeout,
      clearInterval: timers.clearInterval,
    };
    timers.setTimeout = holding(saved.setTimeout.bind(globalThis));
    timers.setInterval = holding(saved.setInterval.bind(globalThis));
    timers.clearTimeout = clearing(saved.clearTimeout.bind(globalThis));
    timers.clearInterval = clearing(saved.clearInterval.bind(globalThis));
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders === 0 && saved !== null) {
      Object.assign(timers, saved);
      saved = null;
      held.clear();
    }
  };
}

/** Whether the clock is held now. */
export function clockHeld(): boolean {
  return saved !== null;
}
