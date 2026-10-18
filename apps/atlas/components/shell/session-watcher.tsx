"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { onDemand, useOnDemand } from "./on-demand";

/** The sign-in dialog loads only when the session has expired (A24-009). */
const dialog = onDemand(() => import("./session-dialog"));

/**
 * Session continuity (Section 11.7). Tokens refresh silently through the proxy; when the session is
 * gone (`/auth/session` answers 401), a sign-in dialog opens over the page, so nothing typed on the
 * page is lost, and closes once the person signs in again. Sign-out in one tab signs every tab out
 * through BroadcastChannel.
 */
export const SESSION_CHANNEL = "xos-session";
const POLL_MS = 60_000;

export function SessionWatcher({ email }: { email: string | null }) {
  const router = useRouter();
  const [expired, setExpired] = useState(false);
  const loaded = useOnDemand(dialog, expired);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const response = await fetch("/auth/session", { cache: "no-store" });
        if (!cancelled && response.status === 401) setExpired(true);
      } catch (error) {
        // Offline or a network blip: the session may be fine; check again on the next tick.
        console.warn("Session check failed", error);
      }
    };
    const timer = window.setInterval(check, POLL_MS);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return undefined;
    const channel = new BroadcastChannel(SESSION_CHANNEL);
    channel.onmessage = (event: MessageEvent<{ type: string }>) => {
      if (event.data.type === "signed-out") router.push("/auth/sign-in?signedOut=1");
      if (event.data.type === "preferences") router.refresh();
    };
    return () => channel.close();
  }, [router]);

  if (!expired) return null;
  return loaded ? (
    <loaded.SessionDialog email={email} onSignedIn={() => setExpired(false)} />
  ) : null;
}

/** Tells the other tabs that this one signed out or changed a preference. */
export function broadcast(type: "signed-out" | "preferences"): void {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(SESSION_CHANNEL);
  channel.postMessage({ type });
  channel.close();
}
