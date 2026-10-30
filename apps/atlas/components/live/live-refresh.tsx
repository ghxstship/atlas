"use client";

import { useLive, type LivePacing, type LiveTopic } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useTransition } from "react";
import { forgetWaitingRefresh, holdLiveRefresh, refreshWhenFree } from "./live-hold";

/**
 * Forms on the page holding input not yet saved. A refresh then would re-render a form's hidden
 * version field (`expectedUpdatedAt`) with someone else's newer save, and the person's save would
 * overwrite it unseen; holding the refresh keeps the stale-save check, so no change is lost
 * silently (Section 11.7). Search boxes do not count. Submitting saves through the action, whose
 * revalidation rereads the page anyway, and a form that leaves the page stops counting.
 */
const dirtyForms = new Set<HTMLFormElement>();
let tracking = false;

function trackForms(): void {
  if (tracking || typeof document === "undefined") return;
  tracking = true;
  document.addEventListener(
    "input",
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const form = target.closest("form");
      if (!form || form.getAttribute("role") === "search") return;
      if (target instanceof HTMLInputElement && target.type === "search") return;
      dirtyForms.add(form);
    },
    true,
  );
  const clear = (event: Event) => {
    if (event.target instanceof HTMLFormElement) dirtyForms.delete(event.target);
  };
  document.addEventListener("submit", clear, true);
  document.addEventListener("reset", clear, true);
}

function editing(): boolean {
  for (const form of dirtyForms) if (!form.isConnected) dirtyForms.delete(form);
  return dirtyForms.size > 0;
}

/**
 * Rereads the page when rows it shows change (Section 11.7, ADR 0044). The page renders on the
 * server as always; a batch of changes refreshes it in a transition, which keeps client state such
 * as a selection or an open menu. While a form holds unsaved input the refresh waits, and while a
 * dialog holds refreshes (`useHoldLiveRefresh`) it runs once the dialog closes. Pass topics
 * narrowed to the org or the record, for example `{ table: "records", filter: "org_id=eq.<id>" }`.
 */
export function useLiveRefresh(topics: readonly LiveTopic[] | null, pacing?: LivePacing): void {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const key = useRef({});
  useEffect(trackForms, []);
  useEffect(() => {
    const page = key.current;
    return () => forgetWaitingRefresh(page);
  }, []);
  useLive(
    topics,
    () => {
      if (editing()) return;
      refreshWhenFree(key.current, () => startTransition(() => router.refresh()));
    },
    pacing,
  );
}

/**
 * Holds the page's live refreshes while `active`. For a dialog showing something a refresh would
 * unmount for good, such as a link and access code shown only once; a change that arrives
 * meanwhile rereads the page once the hold ends.
 */
export function useHoldLiveRefresh(active: boolean): void {
  useEffect(() => (active ? holdLiveRefresh() : undefined), [active]);
}

/** `useLiveRefresh` for server pages: renders nothing. */
export function LiveRefresh({
  topics,
  pacing,
}: {
  topics: readonly LiveTopic[];
  pacing?: LivePacing;
}): null {
  useLiveRefresh(topics, pacing);
  return null;
}
