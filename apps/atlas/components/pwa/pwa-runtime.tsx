"use client";

import {
  afterHydration,
  currentPushSubscription,
  forgetOfflinePages,
  registerServiceWorker,
  rememberPage,
} from "@xos/ui/pwa/client";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { syncWebPushAction } from "@/lib/pwa/push-actions";

const PUSH_SYNCED = "xos-push-synced";

/** Checks the browser's push subscription once a session: another person's is dropped (1533). */
async function syncPush(): Promise<void> {
  try {
    if (window.sessionStorage.getItem(PUSH_SYNCED)) return;
  } catch {
    // Storage blocked: check every visit instead.
  }
  const subscription = await currentPushSubscription();
  if (!subscription) return;
  const result = await syncWebPushAction(subscription.toJSON());
  if (result === "unknown") await subscription.unsubscribe();
  if (result === "signed-out") return;
  try {
    window.sessionStorage.setItem(PUSH_SYNCED, "1");
  } catch {
    // Storage blocked: nothing to remember.
  }
}

/**
 * Atlas's installable-app runtime (Section 4.10 and 11.14, A96, ADR 0052), mounted once in the root layout. After the
 * page hydrates and the browser is idle it registers the service worker, clears the offline pages after a sign-out,
 * checks the browser's push subscription, and, only when the consent seam allowed it, loads product analytics. Each
 * client-side navigation asks the worker to keep the page for offline reading. Renders nothing.
 */
export function PwaRuntime({ analytics }: { readonly analytics: boolean }) {
  const pathname = usePathname();
  const ready = useRef(false);
  const tracker = useRef<{ pageViewed(path: string): void } | null>(null);

  useEffect(() => {
    afterHydration(() => {
      void (async () => {
        if (
          window.location.pathname === "/auth/sign-in" &&
          new URLSearchParams(window.location.search).has("signedOut")
        ) {
          forgetOfflinePages();
        }
        ready.current = (await registerServiceWorker()) !== null;
        if (ready.current) await syncPush().catch(() => undefined);
        if (analytics) {
          const { startAnalytics } = await import("@/lib/pwa/analytics-client");
          tracker.current = startAnalytics();
          tracker.current.pageViewed(window.location.pathname);
        }
      })();
    });
  }, [analytics]);

  useEffect(() => {
    if (ready.current) rememberPage(pathname);
    tracker.current?.pageViewed(pathname);
  }, [pathname]);

  return null;
}
