"use client";

import { useEffect, useState } from "react";

/**
 * A module the browser fetches the first time someone needs it, not with the page (A24-009,
 * ADR 0027). Panels, dialogs and menus that render nothing until opened live behind one, so their
 * code (and libraries such as cmdk and the Radix dialog) stays out of every route's JavaScript.
 * The same helper as Atlas's components/shell/on-demand.ts; apps do not import each other.
 */
export interface OnDemand<T> {
  /** Starts the fetch (once) and resolves with the module. */
  readonly load: () => Promise<T>;
  /** The module when it has already loaded. */
  readonly current: () => T | null;
}

export function onDemand<T>(importer: () => Promise<T>): OnDemand<T> {
  let promise: Promise<T> | null = null;
  let value: T | null = null;
  return {
    load: () =>
      (promise ??= importer().then(
        (m) => (value = m),
        (error: unknown) => {
          // A failed chunk fetch (offline, a new deploy) may succeed on the next attempt.
          promise = null;
          throw error;
        },
      )),
    current: () => value,
  };
}

/**
 * The module once `wanted` has been true, loading it then; null before. Call `load` early (on
 * hover or focus of the control that opens it) to have it ready by the click.
 */
export function useOnDemand<T>(module: OnDemand<T>, wanted: boolean): T | null {
  const [value, setValue] = useState<T | null>(module.current);
  useEffect(() => {
    if (!wanted || value !== null) return;
    let live = true;
    module.load().then(
      (m) => {
        if (live) setValue(() => m);
      },
      (error: unknown) => console.error("Could not load a panel", error),
    );
    return () => {
      live = false;
    };
  }, [module, wanted, value]);
  return value;
}
