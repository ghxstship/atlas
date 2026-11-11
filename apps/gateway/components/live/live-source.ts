import type { LiveHub as Hub, LiveRoom } from "@xos/data/live";
import type { LiveSource } from "@xos/ui";

/** What `/auth/realtime` answers for a signed-in person. */
interface RealtimeGrant {
  readonly url: string;
  readonly key: string;
  readonly token: string;
  readonly expiresAt: number;
}

async function fetchGrant(): Promise<RealtimeGrant | null> {
  const response = await fetch("/auth/realtime", { cache: "no-store", credentials: "same-origin" });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`Live updates could not start (${response.status}).`);
  return (await response.json()) as RealtimeGrant;
}

/** Resolves once the browser is idle, so live updates never compete with hydration. */
function idle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(() => resolve(), { timeout: 2_000 });
    } else {
      setTimeout(resolve, 500);
    }
  });
}

let hub: Promise<Hub | null> | null = null;

/**
 * The tab's live hub (`@xos/data/live`), as in Atlas (ADR 0044): created the first time a page
 * watches something, with the Realtime client fetched then, on demand (ADR 0027). Apps do not
 * import each other, so Gateway keeps its own copy of this loader.
 */
export function loadHub(): Promise<Hub | null> {
  hub ??= (async () => {
    await idle();
    const [grant, live] = await Promise.all([fetchGrant(), import("@xos/data/live")]);
    if (!grant) return null;
    let first: RealtimeGrant | null = grant;
    return live.createLiveHub({
      url: grant.url,
      apiKey: grant.key,
      token: async () => {
        // The grant that started the hub carries the first token; later ones are fetched fresh.
        const next = first ?? (await fetchGrant());
        first = null;
        return next ? { token: next.token, expiresAt: next.expiresAt } : null;
      },
    });
  })().catch((error: unknown) => {
    // Offline or a new deploy: the next page that watches tries again.
    hub = null;
    // eslint-disable-next-line xos/no-server-console -- runs in the browser: only client components import it
    console.error(error);
    return null;
  });
  return hub;
}

/** The source the shell's LiveProvider hands every `useLive` in Gateway. */
export const gatewayLiveSource: LiveSource = {
  watch(topics, listener, pacing) {
    let stop: (() => void) | null = null;
    let cancelled = false;
    void loadHub().then((h) => {
      if (h && !cancelled) stop = h.watch(topics, listener, pacing);
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  },
};

/**
 * Joins the person's private channel (`gateway:<person id>`, migration 2161) and calls `onPing`
 * for each change ping, and `onRejoin` when the channel comes back after a drop, since pings sent
 * while it was away were missed. Realtime refuses the join for anyone but that person.
 */
export function watchChannel(topic: string, onPing: () => void, onRejoin: () => void): () => void {
  let room: LiveRoom | null = null;
  let cancelled = false;
  let joined = false;
  void loadHub().then((h) => {
    if (!h || cancelled) return;
    room = h.room(
      topic,
      { events: ["changed"], presenceKey: "gateway" },
      {
        onBroadcast: () => onPing(),
        onStatus: (status) => {
          if (status !== "joined") return;
          if (joined) onRejoin();
          joined = true;
        },
      },
    );
  });
  return () => {
    cancelled = true;
    room?.leave();
  };
}
