"use client";

import { startTransition, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  browserGlobalPrivacyControl,
  decideConsent,
  type ConsentAdapter,
  type ConsentChoice,
  type ConsentState,
} from "./consent.ts";

/** Where the components keep the decision themselves, and the policy version they record with it. */
export interface ConsentRecording {
  readonly adapter: ConsentAdapter;
  /** The version of the cookie policy the copy describes, written with every decision. */
  readonly policyVersion: string;
}

/**
 * A form action for the choice: a URL the forms post to, or a function React calls with the form
 * data (a Next.js server action fits). The fields are `choice` (`all`, `none` or `save`), one
 * field per ticked category with the value `on`, and `gpc` with the value `1` when the browser
 * reported Global Privacy Control and the request did not.
 */
export type ConsentAction = string | ((form: FormData) => void | Promise<void>);

interface ConsentOptions {
  readonly gpc: boolean | undefined;
  readonly categories: readonly string[];
  readonly record: ConsentRecording | undefined;
  readonly action: ConsentAction | undefined;
  readonly onChoice: ((choice: ConsentChoice) => void) | undefined;
}

interface Consent {
  /** A Global Privacy Control signal is present, from the request (`gpc`) or the browser. */
  readonly signal: boolean;
  /** With an adapter: undefined until it has been read, then the stored consent or null. */
  readonly stored: ConsentState | null | undefined;
  /** Records a choice through the adapter, when there is one, and tells `onChoice`. */
  choose(choice: ConsentChoice, selected?: Iterable<string>): void;
}

const subscribe = (): (() => void) => () => undefined;
const serverSignal = (): boolean => false;
const browserSignal = (): boolean => browserGlobalPrivacyControl();

/**
 * The state ConsentBanner and ConsentSettings share. Global Privacy Control counts as a refusal
 * from either source. When only the browser reports it, the refusal is recorded once: through the
 * adapter, or by calling a function `action` with `choice=none` and `gpc=1`.
 */
export function useConsent(options: ConsentOptions): Consent {
  const browser = useSyncExternalStore(subscribe, browserSignal, serverSignal);
  const signal = options.gpc === true || browser;
  const [stored, setStored] = useState<ConsentState | null | undefined>(undefined);
  const latest = useRef(options);
  const reported = useRef(false);
  const tracked = options.record !== undefined;

  useEffect(() => {
    latest.current = options;
  });

  useEffect(() => {
    const record = latest.current.record;
    if (record === undefined) return undefined;
    let current = true;
    void record.adapter.read().then(
      (state) => {
        if (current) setStored(state);
      },
      () => {
        if (current) setStored(null);
      },
    );
    return () => {
      current = false;
    };
  }, [tracked]);

  useEffect(() => {
    if (!signal || reported.current) return;
    const { record, action, categories, onChoice, gpc } = latest.current;
    if (record !== undefined) {
      if (stored === undefined) return;
      reported.current = true;
      if (stored?.gpc === true) return;
      const decision = decideConsent({
        choice: "none",
        categories,
        gpc: true,
        policyVersion: record.policyVersion,
      });
      void record.adapter.write(decision).then(
        () => setStored(decision),
        () => undefined,
      );
      onChoice?.("none");
      return;
    }
    reported.current = true;
    // The request already carried the signal, so the server has recorded it.
    if (gpc === true) return;
    if (typeof action === "function") {
      const form = new FormData();
      form.set("choice", "none");
      form.set("gpc", "1");
      startTransition(() => {
        void action(form);
      });
    }
    onChoice?.("none");
  }, [signal, stored]);

  function choose(choice: ConsentChoice, selected?: Iterable<string>): void {
    const { record, categories, onChoice } = latest.current;
    if (record !== undefined) {
      const decision = decideConsent({
        choice,
        categories,
        ...(selected === undefined ? {} : { selected }),
        gpc: signal,
        policyVersion: record.policyVersion,
      });
      // A failed write leaves the choices on screen, so the visitor can choose again.
      void record.adapter.write(decision).then(
        () => setStored(decision),
        () => undefined,
      );
    }
    onChoice?.(choice);
  }

  return { signal, stored, choose };
}

/** The ticked category names in a form, read when Save is pressed. */
export function tickedCategories(form: HTMLFormElement | null, names: readonly string[]): string[] {
  if (form === null) return [];
  const data = new FormData(form);
  return names.filter((name) => data.get(name) === "on");
}
