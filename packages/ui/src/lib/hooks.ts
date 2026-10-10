import { useCallback, useEffect, useRef, useState } from "react";

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
