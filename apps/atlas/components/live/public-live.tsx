"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** A ping refreshes at most once a second, however many arrive (a cue run called fast). */
const DEBOUNCE_MS = 1_000;
/** While the channel is not joined (blocked, dropped, Realtime off), the page pulls this often. */
const FALLBACK_PULL_MS = 15_000;
/** And always this often, in case a ping was lost while joined. */
const SAFETY_PULL_MS = 60_000;
/** The publishable key never expires the way a session token does. */
const FAR_FUTURE = 8_640_000_000_000_000;

/**
 * Live updates for a public live link page (P1, ADR 0130): the small client island of /share/view
 * and /share/screen. It joins the link's private broadcast channel (xlink:<key>) with the publishable
 * key, as anon, and rereads the page through its token RPC on every ping and after every rejoin. The
 * ping carries nothing; the server page decides what it shows. While the channel is not joined it
 * pulls every 15 seconds, and once a minute regardless, so many screens on one link stay well under
 * the per-grant limit. It never tracks presence. The Realtime client loads on demand (ADR 0027).
 */
export function PublicLive({
  url,
  anonKey,
  channel,
}: {
  url: string;
  anonKey: string;
  channel: string | null;
}) {
  const router = useRouter();
  useEffect(() => {
    let joined = false;
    let everJoined = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let leave: (() => void) | null = null;
    const refresh = () => {
      if (debounce !== null) return;
      debounce = setTimeout(() => {
        debounce = null;
        if (!closed) router.refresh();
      }, DEBOUNCE_MS);
    };
    const fallback = setInterval(() => {
      if (!joined) router.refresh();
    }, FALLBACK_PULL_MS);
    const safety = setInterval(() => router.refresh(), SAFETY_PULL_MS);

    if (channel) {
      void import("@xos/data/live").then(({ createLiveHub }) => {
        if (closed) return;
        const hub = createLiveHub({
          url,
          apiKey: anonKey,
          token: async () => ({ token: anonKey, expiresAt: FAR_FUTURE }),
        });
        const room = hub.room(
          channel,
          { events: ["changed"], presenceKey: `screen-${Math.random().toString(36).slice(2, 10)}` },
          {
            onBroadcast: refresh,
            onStatus: (status) => {
              joined = status === "joined";
              // A rejoin may have missed pings while the channel was down.
              if (joined && everJoined) refresh();
              if (joined) everJoined = true;
            },
          },
        );
        leave = () => {
          room.leave();
          hub.close();
        };
      });
    }
    return () => {
      closed = true;
      clearInterval(fallback);
      clearInterval(safety);
      if (debounce !== null) clearTimeout(debounce);
      leave?.();
    };
  }, [router, url, anonKey, channel]);
  return null;
}
