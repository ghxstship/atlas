/** Section 11.7: a record key previews after 400 ms. */
export const OPEN_DELAY_MS = 400;

/** The timing of a hover card; see hoverIntent. */
export interface HoverIntent<K, V> {
  /**
   * The pointer or focus is on `key`. On the same key nothing changes, so moving across a cell's
   * text never restarts the wait. On another key the wait starts again, and with no `value` (a part
   * with nothing to preview) no card follows. True when the key changed, so a card already shown
   * closes.
   */
  enter: (key: K | null, value?: V) => boolean;
  /** The pointer or focus left: the wait stops and the next enter starts afresh. */
  leave: () => void;
}

/**
 * When a hover card shows (Section 11.7): `show` runs once the pointer or focus has stayed on one key
 * for the delay, 400 ms by default; leaving or moving to another key first cancels it.
 */
export function hoverIntent<K, V>(
  show: (value: V, key: K) => void,
  delay: number = OPEN_DELAY_MS,
): HoverIntent<K, V> {
  let current: K | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    enter: (key, value) => {
      if (key === current) return false;
      cancel();
      current = key;
      if (key !== null && value !== undefined) {
        timer = setTimeout(() => {
          timer = null;
          show(value, key);
        }, delay);
      }
      return true;
    },
    leave: () => {
      cancel();
      current = null;
    },
  };
}
