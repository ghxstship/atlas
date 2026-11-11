"use client";

import { useLive, type LiveTopic } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";
import { createPacer } from "@/lib/live/topics";
import { watchChannel } from "./live-source";

/**
 * Forms on the page holding input not yet saved: a refresh then waits, as in Atlas's LiveRefresh,
 * so a form's hidden version field never takes someone else's newer save unseen (Section 11.7).
 * Search boxes do not count; submitting or resetting a form stops it counting.
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
 * Rereads a Gateway list when rows it shows change (Section 11.7, ADR 0082). The page renders on
 * the server as always; a change refreshes it in a transition, which keeps a selection or an open
 * menu. `topics` are published tables narrowed to the person's rows; `channel` is the person's
 * private channel, for lists of engagements, invoices and payments, whose tables are not published
 * to external people.
 */
export function LiveRefresh({
  topics,
  channel,
}: {
  topics?: readonly LiveTopic[];
  channel?: string | null;
}): null {
  const router = useRouter();
  const [, startTransition] = useTransition();
  useEffect(trackForms, []);
  useLive(topics && topics.length > 0 ? topics : null, () => {
    if (editing()) return;
    startTransition(() => router.refresh());
  });
  useEffect(() => {
    if (!channel) return undefined;
    const pacer = createPacer(() => {
      if (editing()) return;
      startTransition(() => router.refresh());
    });
    const stop = watchChannel(channel, pacer.ping, pacer.ping);
    return () => {
      pacer.stop();
      stop();
    };
  }, [channel, router]);
  return null;
}
