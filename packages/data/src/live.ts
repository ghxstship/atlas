import { RealtimeClient, type RealtimeClientOptions } from "@supabase/realtime-js";

/**
 * Live updates for lists and records (Section 11.7, A65-006, ADR 0044): one Supabase Realtime
 * connection per tab and one channel per page, multiplexing every `postgres_changes` binding the
 * page's components ask for. Realtime authorizes each change with the person's own JWT, so row
 * level security decides what reaches the page, exactly as it does for a read.
 *
 * The hub never refetches anything itself. It tells each watcher, in batches, that rows it watches
 * changed; the page then rereads through its normal server path. Batches are throttled, and the
 * interval doubles while changes keep arriving back to back (up to `maxIntervalMs`), so a busy
 * table, or a page whose own render writes a watched row, can never refetch in a loop. A hidden tab
 * holds its batch until it is visible again. After a dropped connection the hub resubscribes with a
 * jittered back-off and sends one `RESYNC` batch, because changes made while it was away were missed.
 *
 * This module carries the Realtime client, so apps load it on demand (ADR 0027), never in the shell.
 */

/** One watched table, optionally narrowed with a Realtime filter such as `org_id=eq.<uuid>`. */
export interface LiveTopic {
  readonly table: string;
  readonly filter?: string;
}

export type LiveChangeType = "INSERT" | "UPDATE" | "DELETE" | "RESYNC";

/** A change to one watched row, or `RESYNC` after a reconnect (table `*`, no id). */
export interface LiveChange {
  readonly table: string;
  readonly type: LiveChangeType;
  readonly id: string | null;
}

export type LiveListener = (changes: readonly LiveChange[]) => void;

/** `connecting` until the first subscription, `live` while subscribed, `offline` when signed out. */
export type LiveStatus = "idle" | "connecting" | "live" | "reconnecting" | "offline";

/** A short-lived access token for Realtime and when it expires (epoch milliseconds). */
export interface LiveToken {
  readonly token: string;
  readonly expiresAt: number;
}

/** The part of a Postgres change payload the hub reads. */
export interface LivePayload {
  readonly eventType: string;
  readonly table: string;
  readonly new?: Record<string, unknown> | null;
  readonly old?: Record<string, unknown> | null;
}

export interface LiveChannelLike {
  on(
    type: "postgres_changes",
    filter: { event: "*"; schema: string; table: string; filter?: string },
    callback: (payload: LivePayload) => void,
  ): LiveChannelLike;
  on(
    type: "broadcast",
    filter: { event: string },
    callback: (message: { payload?: unknown }) => void,
  ): LiveChannelLike;
  on(type: "presence", filter: { event: "sync" }, callback: () => void): LiveChannelLike;
  subscribe(callback: (status: string, error?: Error) => void): LiveChannelLike;
  send?(message: { type: "broadcast"; event: string; payload: unknown }): Promise<unknown>;
  track?(state: Record<string, unknown>): Promise<unknown>;
  presenceState?(): Record<string, readonly Record<string, unknown>[]>;
}

/** Channel settings for a room: private (authorized per topic), its presence key, never echoing itself. */
export interface LiveChannelOptions {
  readonly config: {
    readonly private: boolean;
    readonly broadcast: { readonly self: boolean };
    readonly presence: { readonly key: string };
  };
}

export interface LiveClientLike {
  channel(topic: string, options?: LiveChannelOptions): LiveChannelLike;
  removeChannel(channel: LiveChannelLike): Promise<unknown>;
  disconnect(): unknown;
}

/** What a room tells its owner: broadcasts, who is present, and whether it is joined. */
export interface LiveRoomHandlers {
  onBroadcast(event: string, payload: Record<string, unknown>): void;
  onPresence?(members: readonly Record<string, unknown>[]): void;
  /** `joined` after every (re)join, `lost` when the channel drops; a rejoin should resync. */
  onStatus?(status: "joined" | "lost"): void;
}

export interface LiveRoom {
  /** Broadcasts to everyone else in the room; false when it could not be sent. */
  send(event: string, payload: Record<string, unknown>): Promise<boolean>;
  /** Shares this tab's presence (a name, a color). */
  track(state: Record<string, unknown>): Promise<void>;
  leave(): void;
}

export interface LiveClientOptions {
  readonly apiKey: string;
  readonly accessToken: () => Promise<string | null>;
  readonly reconnectAfterMs: (tries: number) => number;
}

/** Timers and the clock, injectable for tests. */
export interface LiveClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Whether the page is hidden and a way to hear when that changes. */
export interface LiveVisibility {
  hidden(): boolean;
  onChange(callback: () => void): () => void;
}

export interface LiveHubOptions {
  /** Supabase API origin, for example https://xyz.supabase.co. */
  readonly url: string;
  /** Publishable (anon) key. */
  readonly apiKey: string;
  /** A fresh access token for the signed-in person, or null when the session is gone. */
  readonly token: () => Promise<LiveToken | null>;
  readonly schema?: string;
  readonly createClient?: (endpoint: string, options: LiveClientOptions) => LiveClientLike;
  /** Changes are gathered this long before a batch goes out. */
  readonly batchMs?: number;
  /** The shortest time between two batches to one watcher. */
  readonly minIntervalMs?: number;
  /** The longest the interval grows to while changes keep coming. */
  readonly maxIntervalMs?: number;
  /** Watch and unwatch calls within this time rebuild the channel once. */
  readonly rebuildMs?: number;
  /** With no watcher left for this long, the socket closes. */
  readonly idleMs?: number;
  readonly clock?: LiveClock;
  readonly visibility?: LiveVisibility;
  readonly random?: () => number;
}

/** Per-watcher pacing; show mode follows cues faster than a list follows its rows. */
export interface LivePacing {
  readonly batchMs?: number;
  readonly minIntervalMs?: number;
  readonly maxIntervalMs?: number;
}

export interface LiveHub {
  /** Starts watching topics; the returned function stops. */
  watch(topics: readonly LiveTopic[], listener: LiveListener, pacing?: LivePacing): () => void;
  /**
   * Joins a private broadcast room on the same socket (live co-editing, ADR 0044): Realtime
   * authorizes the topic for the person's token, for broadcasts and presence alike.
   */
  room(
    topic: string,
    options: { readonly events: readonly string[]; readonly presenceKey: string },
    handlers: LiveRoomHandlers,
  ): LiveRoom;
  status(): LiveStatus;
  onStatus(listener: (status: LiveStatus) => void): () => void;
  close(): void;
}

/** Tokens are refreshed this long before they expire. */
const TOKEN_MARGIN_MS = 60_000;

/** A batch longer than this becomes one RESYNC: the page rereads everything anyway. */
const MAX_PENDING = 100;

const TABLE = /^[a-z][a-z0-9_]{0,62}$/;
const FILTER =
  /^[a-z][a-z0-9_]{0,62}=(eq|neq|lt|lte|gt|gte|in)\.[^,\s]{1,400}$|^[a-z][a-z0-9_]{0,62}=in\.\([^\s]{1,2000}\)$/;

/** A topic Realtime accepts: a plain table name and at most one simple filter. */
export function isLiveTopic(topic: LiveTopic): boolean {
  return TABLE.test(topic.table) && (topic.filter === undefined || FILTER.test(topic.filter));
}

function topicKey(topic: LiveTopic): string {
  return `${topic.table}|${topic.filter ?? ""}`;
}

/** Reconnect delay: doubling from 1 s to 30 s, spread by half either way so tabs never retry in step. */
export function reconnectDelay(tries: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1_000 * 2 ** Math.max(0, Math.min(tries - 1, 5)));
  return Math.round(base * (0.5 + random()));
}

/** The Realtime websocket endpoint of a Supabase API origin. */
export function realtimeEndpoint(url: string): string {
  return `${url.replace(/\/+$/, "").replace(/^http/i, "ws")}/realtime/v1`;
}

const systemClock: LiveClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface DocumentLike {
  readonly hidden: boolean;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

function documentVisibility(): LiveVisibility {
  const doc = (globalThis as { document?: DocumentLike }).document;
  return {
    hidden: () => doc?.hidden ?? false,
    onChange: (callback) => {
      doc?.addEventListener("visibilitychange", callback);
      return () => doc?.removeEventListener("visibilitychange", callback);
    },
  };
}

function realtimeClient(endpoint: string, options: LiveClientOptions): LiveClientLike {
  const settings: RealtimeClientOptions = {
    params: { apikey: options.apiKey },
    accessToken: options.accessToken,
    reconnectAfterMs: options.reconnectAfterMs,
  };
  const client = new RealtimeClient(endpoint, settings);
  // realtime-js types `on` with overloads per listen type; the hub binds postgres_changes only.
  return client as unknown as LiveClientLike;
}

interface Watcher {
  readonly keys: ReadonlySet<string>;
  readonly listener: LiveListener;
  readonly batchMs: number;
  readonly minInterval: number;
  readonly maxInterval: number;
  pending: LiveChange[];
  timer: unknown;
  lastDelivery: number;
  interval: number;
}

export function createLiveHub(options: LiveHubOptions): LiveHub {
  const schema = options.schema ?? "app";
  const batchMs = options.batchMs ?? 300;
  const minInterval = options.minIntervalMs ?? 2_000;
  const maxInterval = options.maxIntervalMs ?? 30_000;
  const rebuildMs = options.rebuildMs ?? 50;
  const idleMs = options.idleMs ?? 60_000;
  const clock = options.clock ?? systemClock;
  const visibility = options.visibility ?? documentVisibility();
  const random = options.random ?? Math.random;
  const createClient = options.createClient ?? realtimeClient;

  const watchers = new Set<Watcher>();
  const statusListeners = new Set<(status: LiveStatus) => void>();
  let current: LiveStatus = "idle";
  let client: LiveClientLike | null = null;
  let channel: LiveChannelLike | null = null;
  let channelKeys = "";
  let channelCount = 0;
  let wasSubscribed = false;
  let rebuildTimer: unknown = null;
  let idleTimer: unknown = null;
  let cached: LiveToken | null = null;
  let closed = false;
  let rooms = 0;

  const setStatus = (next: LiveStatus) => {
    if (next === current) return;
    current = next;
    for (const listener of statusListeners) listener(next);
  };

  const accessToken = async (): Promise<string | null> => {
    if (cached && cached.expiresAt - clock.now() > TOKEN_MARGIN_MS) return cached.token;
    try {
      cached = await options.token();
    } catch {
      // A failed refresh keeps the last token until it expires; Realtime retries on its heartbeat.
      return cached && cached.expiresAt > clock.now() ? cached.token : null;
    }
    if (cached === null) setStatus("offline");
    return cached?.token ?? null;
  };

  const flush = (watcher: Watcher) => {
    watcher.timer = null;
    if (!watchers.has(watcher) || watcher.pending.length === 0) return;
    if (visibility.hidden()) return; // delivered when the tab is visible again
    const now = clock.now();
    const wait = watcher.lastDelivery + watcher.interval - now;
    if (wait > 0) {
      watcher.timer = clock.setTimeout(() => flush(watcher), wait);
      return;
    }
    // Back to back batches double the interval; a quiet spell resets it.
    watcher.interval =
      now - watcher.lastDelivery < watcher.interval * 2
        ? Math.min(watcher.maxInterval, watcher.interval * 2)
        : watcher.minInterval;
    watcher.lastDelivery = now;
    const batch = watcher.pending;
    watcher.pending = [];
    watcher.listener(batch);
  };

  const enqueue = (watcher: Watcher, change: LiveChange) => {
    const pending = watcher.pending;
    if (pending.length === 1 && pending[0]?.type === "RESYNC") {
      // Already rereading everything.
    } else if (change.type === "RESYNC" || pending.length >= MAX_PENDING) {
      watcher.pending = [{ table: "*", type: "RESYNC", id: null }];
    } else if (
      !pending.some((c) => c.table === change.table && c.id === change.id && c.type === change.type)
    ) {
      pending.push(change);
    }
    if (watcher.timer === null) {
      watcher.timer = clock.setTimeout(() => flush(watcher), watcher.batchMs);
    }
  };

  const dispatch = (key: string, payload: LivePayload) => {
    const row = payload.new && Object.keys(payload.new).length > 0 ? payload.new : payload.old;
    const id = typeof row?.["id"] === "string" ? row["id"] : null;
    const type = (["INSERT", "UPDATE", "DELETE"] as const).find((t) => t === payload.eventType);
    if (!type) return;
    for (const watcher of watchers) {
      if (watcher.keys.has(key)) enqueue(watcher, { table: payload.table, type, id });
    }
  };

  const resync = () => {
    for (const watcher of watchers) enqueue(watcher, { table: "*", type: "RESYNC", id: null });
  };

  const dropChannel = () => {
    // Forget the channel first: removing it reports CLOSED, which is not a dropped connection.
    const old = channel;
    channel = null;
    channelKeys = "";
    wasSubscribed = false;
    if (client && old) void client.removeChannel(old);
  };

  const shutdown = () => {
    dropChannel();
    if (client) void client.disconnect();
    client = null;
    cached = null;
  };

  const ensureClient = (): LiveClientLike => {
    client ??= createClient(realtimeEndpoint(options.url), {
      apiKey: options.apiKey,
      accessToken,
      reconnectAfterMs: (tries) => reconnectDelay(tries, random),
    });
    return client;
  };

  const scheduleIdle = () => {
    idleTimer ??= clock.setTimeout(() => {
      idleTimer = null;
      if (watchers.size === 0 && rooms === 0) shutdown();
    }, idleMs);
  };

  const cancelIdle = () => {
    if (idleTimer !== null) {
      clock.clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const rebuild = () => {
    rebuildTimer = null;
    if (closed) return;
    const topics = new Map<string, LiveTopic>();
    for (const watcher of watchers) {
      for (const key of watcher.keys) {
        const [table = "", filter = ""] = key.split("|");
        topics.set(key, filter ? { table, filter } : { table });
      }
    }
    const keys = [...topics.keys()].sort().join(",");
    if (keys === channelKeys && channel) return;
    dropChannel();
    if (topics.size === 0) {
      setStatus("idle");
      if (rooms === 0) scheduleIdle();
      return;
    }
    cancelIdle();
    channelCount += 1;
    let next = ensureClient().channel(`live:${channelCount}`);
    for (const [key, topic] of topics) {
      next = next.on(
        "postgres_changes",
        {
          event: "*",
          schema,
          table: topic.table,
          ...(topic.filter ? { filter: topic.filter } : {}),
        },
        (payload) => dispatch(key, payload),
      );
    }
    channel = next;
    channelKeys = keys;
    if (current !== "offline") setStatus(wasSubscribed ? "reconnecting" : "connecting");
    const mine = next;
    next.subscribe((status) => {
      if (channel !== mine) return;
      if (status === "SUBSCRIBED") {
        if (wasSubscribed) resync();
        wasSubscribed = true;
        setStatus("live");
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        if (current !== "offline") setStatus(wasSubscribed ? "reconnecting" : "connecting");
      }
    });
  };

  const scheduleRebuild = () => {
    if (rebuildTimer !== null) return;
    rebuildTimer = clock.setTimeout(rebuild, rebuildMs);
  };

  const unlistenVisibility = visibility.onChange(() => {
    if (visibility.hidden()) return;
    for (const watcher of watchers) {
      if (watcher.pending.length > 0 && watcher.timer === null) flush(watcher);
    }
  });

  return {
    watch(topics, listener, pacing = {}) {
      const keys = new Set(topics.filter(isLiveTopic).map(topicKey));
      if (closed || keys.size === 0) return () => undefined;
      const floor = pacing.minIntervalMs ?? minInterval;
      const watcher: Watcher = {
        keys,
        listener,
        batchMs: pacing.batchMs ?? batchMs,
        minInterval: floor,
        maxInterval: Math.max(floor, pacing.maxIntervalMs ?? maxInterval),
        pending: [],
        timer: null,
        lastDelivery: Number.NEGATIVE_INFINITY,
        interval: floor,
      };
      watchers.add(watcher);
      scheduleRebuild();
      return () => {
        if (!watchers.delete(watcher)) return;
        if (watcher.timer !== null) clock.clearTimeout(watcher.timer);
        scheduleRebuild();
      };
    },
    room(topic, { events, presenceKey }, handlers) {
      if (closed) {
        return {
          send: () => Promise.resolve(false),
          track: () => Promise.resolve(),
          leave: () => undefined,
        };
      }
      cancelIdle();
      const owner = ensureClient();
      let room = owner.channel(topic, {
        config: { private: true, broadcast: { self: false }, presence: { key: presenceKey } },
      });
      for (const event of events) {
        room = room.on("broadcast", { event }, (message) => {
          const payload = message.payload;
          if (payload && typeof payload === "object") {
            handlers.onBroadcast(event, payload as Record<string, unknown>);
          }
        });
      }
      const joinedRoom = room;
      if (handlers.onPresence) {
        room = room.on("presence", { event: "sync" }, () => {
          const state = joinedRoom.presenceState?.() ?? {};
          handlers.onPresence?.(Object.values(state).flat());
        });
      }
      rooms += 1;
      let left = false;
      let joined = false;
      room.subscribe((status) => {
        if (left) return;
        if (status === "SUBSCRIBED") {
          joined = true;
          handlers.onStatus?.("joined");
        } else if (
          joined &&
          (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED")
        ) {
          joined = false;
          handlers.onStatus?.("lost");
        }
      });
      return {
        async send(event, payload) {
          if (left || !joinedRoom.send) return false;
          try {
            return (await joinedRoom.send({ type: "broadcast", event, payload })) === "ok";
          } catch {
            return false;
          }
        },
        async track(state) {
          if (!left) await joinedRoom.track?.(state);
        },
        leave() {
          if (left) return;
          left = true;
          rooms -= 1;
          void owner.removeChannel(joinedRoom);
          if (watchers.size === 0 && rooms === 0) scheduleIdle();
        },
      };
    },
    status: () => current,
    onStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    close() {
      closed = true;
      unlistenVisibility();
      for (const watcher of watchers) {
        if (watcher.timer !== null) clock.clearTimeout(watcher.timer);
      }
      watchers.clear();
      if (rebuildTimer !== null) clock.clearTimeout(rebuildTimer);
      if (idleTimer !== null) clock.clearTimeout(idleTimer);
      shutdown();
      setStatus("idle");
    },
  };
}
