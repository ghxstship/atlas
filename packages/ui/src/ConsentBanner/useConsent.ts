"use client";

import { startTransition, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  browserGlobalPrivacyControl,
  decideConsent,
  type ConsentAdapter,
  type ConsentChoice,
  type ConsentDecision,
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
 * field per ticked category with the value `on`, and `gpc` with the value `1` in every form that
 * is on screen while only the browser reports Global Privacy Control (the request did not).
 *
 * That browser-only signal is also reported once without a form: a function action is called with
 * `choice=none` and `gpc=1`. A URL action receives no such call, because the banner shows no form
 * under the signal and sends no request of its own; a page that posts to a URL records the refusal
 * from `onChoice("none")`, or passes `gpc` from the request header.
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
  /** Only the browser reports the signal, so the forms say so to the server with a `gpc` field. */
  readonly browserOnly: boolean;
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
  /** A decision was written here, so a read still on its way is out of date. */
  const wrote = useRef(false);
  const tracked = options.record !== undefined;

  useEffect(() => {
    latest.current = options;
  });

  useEffect(() => {
    const record = latest.current.record;
    if (record === undefined) return undefined;
    let current = true;
    // Through a promise chain, so an adapter that throws is handled like one that rejects.
    void Promise.resolve()
      .then(() => record.adapter.read())
      .then(
        (state) => {
          if (current && !wrote.current) setStored(state);
        },
        () => {
          if (current && !wrote.current) setStored(null);
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
      write(record, decision);
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

  /** A failed write, thrown or rejected, leaves the choices on screen so the visitor can choose again. */
  function write(record: ConsentRecording, decision: ConsentDecision): void {
    wrote.current = true;
    void Promise.resolve()
      .then(() => record.adapter.write(decision))
      .then(
        () => setStored(decision),
        () => undefined,
      );
  }

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
      write(record, decision);
    }
    onChoice?.(choice);
  }

  return { signal, browserOnly: signal && options.gpc !== true, stored, choose };
}

/** The ticked category names in a form, read when Save is pressed. */
export function tickedCategories(form: HTMLFormElement | null, names: readonly string[]): string[] {
  if (form === null) return [];
  const data = new FormData(form);
  return names.filter((name) => data.get(name) === "on");
}
