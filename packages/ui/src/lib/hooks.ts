import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { singleKeyShortcutsEnabled } from "./preferences.ts";

/**
 * Whether a media query matches. Server rendering and hydration see false, so a layout that switches
 * on it renders the wide markup first and swaps after hydration.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
        return () => undefined;
      }
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  const matches = useCallback(
    () => typeof window.matchMedia === "function" && window.matchMedia(query).matches,
    [query],
  );
  return useSyncExternalStore(subscribe, matches, () => false);
}

/** True below md (48rem, a phone). */
export function useNarrow(): boolean {
  return useMediaQuery("(max-width: 47.999rem)");
}

/** State that a parent may control (`value` given) or leave to the component (`defaultValue`). */
export function useControllable<T>(
  value: T | undefined,
  defaultValue: T,
  onChange?: (next: T) => void,
): [T, (next: T) => void] {
  const [inner, setInner] = useState(defaultValue);
  const controlled = value !== undefined;
  const current = controlled ? value : inner;
  const set = useCallback(
    (next: T) => {
      if (!controlled) setInner(next);
      onChange?.(next);
    },
    [controlled, onChange],
  );
  return [current, set];
}

export interface HotkeyOptions {
  /** Requires Cmd on Apple platforms or Ctrl elsewhere. */
  mod?: boolean;
  /** Ignore the key while typing in a field (default true for unmodified keys). */
  ignoreInFields?: boolean;
  enabled?: boolean;
}

function inField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

/**
 * Binds a document-level shortcut: `useHotkey("k", open, { mod: true })` for the command menu,
 * `useHotkey("?", openSheet)` for the shortcut sheet. Unmodified keys are ignored while typing.
 */
export function useHotkey(
  key: string,
  handler: (event: KeyboardEvent) => void,
  options: HotkeyOptions = {},
): void {
  const { mod = false, ignoreInFields = !mod, enabled = true } = options;
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== key.toLowerCase()) return;
      if (mod !== (event.metaKey || event.ctrlKey)) return;
      if (!mod && !singleKeyShortcutsEnabled()) return;
      if (ignoreInFields && inField(event.target)) return;
      event.preventDefault();
      latest.current(event);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [key, mod, ignoreInFields, enabled]);
}

/** Roving focus over a list of elements along one axis, honoring the text direction. */
export function rovingIndex(
  key: string,
  index: number,
  count: number,
  orientation: "horizontal" | "vertical",
  dir: "ltr" | "rtl" = "ltr",
): number | null {
  const next =
    orientation === "horizontal" ? (dir === "rtl" ? "ArrowLeft" : "ArrowRight") : "ArrowDown";
  const prev =
    orientation === "horizontal" ? (dir === "rtl" ? "ArrowRight" : "ArrowLeft") : "ArrowUp";
  if (key === next) return (index + 1) % count;
  if (key === prev) return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/** The control that asked for an overlay a later render mounts (rememberOverlayOpener). */
let requestedBy: HTMLElement | null = null;

/**
 * Remembers the focused control as the opener of an overlay that mounts after a navigation, such as
 * the side peek a page renders for `?peek`. The route's loading state can hide that control first,
 * which drops focus to the page body, so the overlay would find no opener when it mounts and could
 * not hand focus back on close (WCAG 2.4.3). The next overlay that opens takes it.
 */
export function rememberOverlayOpener(): void {
  const active = document.activeElement;
  requestedBy = active instanceof HTMLElement && active !== document.body ? active : null;
}

/** Whether an element and its ancestors are displayed (React hides a suspended boundary's content). */
function displayed(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (getComputedStyle(node).display === "none") return false;
  }
  return true;
}

/**
 * Focus return for an overlay opened without its own trigger (a hotkey, a row click): remembers the
 * element focused when `open` turns true (or, with focus on the page body, the control that asked
 * for the overlay) and hands it back on close, so focus never drops to the page body (WCAG 2.4.3).
 * Pass the result to Radix `onCloseAutoFocus`.
 *
 * A route's loading state can hide an open overlay together with its opener (React hides a
 * suspended boundary's content and runs its effects again when it shows it). Radix then reports a
 * close while both are hidden, and this effect runs again with focus on the page body; while `open`
 * stays true the opener survives both and takes focus on the real close. Once `open` turns false
 * the opener is used or dropped, so a later open never inherits it.
 */
export function useReturnFocus(open: boolean): (event: Event) => void {
  const opener = useRef<HTMLElement | null>(null);
  const isOpen = useRef(false);
  /* A layout effect runs before the dialog's own focus move (a passive effect), so it still sees
     the opener. */
  useLayoutEffect(() => {
    if (open) {
      const active = document.activeElement;
      const focused = active instanceof HTMLElement && active !== document.body ? active : null;
      const requested = requestedBy?.isConnected ? requestedBy : null;
      requestedBy = null;
      // Kept from the run before only when shown again: the overlay has been open all along.
      const kept = isOpen.current && opener.current?.isConnected ? opener.current : null;
      opener.current = kept ?? focused ?? requested;
    }
    isOpen.current = open;
  }, [open]);
  return useCallback((event: Event) => {
    const target = opener.current;
    if (!target?.isConnected) {
      opener.current = null;
      return;
    }
    event.preventDefault();
    // A loading state hid the open overlay and its opener: keep it for the real close.
    if (isOpen.current && !displayed(target)) return;
    opener.current = null;
    target.focus();
  }, []);
}
