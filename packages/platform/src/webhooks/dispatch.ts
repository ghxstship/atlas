/** A delivery claimed from app.claim_webhook_deliveries, signed by the database. */
export interface ClaimedWebhook {
  readonly deliveryId: string;
  readonly url: string;
  readonly eventType: string;
  readonly body: string;
  readonly signature: string;
}

/** What the dispatcher needs from the database. */
export interface WebhookStore {
  claim(limit: number): Promise<readonly ClaimedWebhook[]>;
  /** Records an attempt: the HTTP status, or null when no response arrived, and the error. Returns the new status. */
  record(deliveryId: string, responseStatus: number | null, error: string | null): Promise<string>;
}

/** Resolves a host name to its IP addresses (Deno.resolveDns or node:dns in production). */
export type HostResolver = (host: string) => Promise<readonly string[]>;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const PRIVATE_V4: readonly [number, number][] = [
  [0x0a000000, 8], // 10.0.0.0/8
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0a80000, 16], // 192.168.0.0/16
  [0x7f000000, 8], // 127.0.0.0/8
  [0xa9fe0000, 16], // 169.254.0.0/16
  [0x64400000, 10], // 100.64.0.0/10
  [0x00000000, 8], // 0.0.0.0/8
];

/** True for an address on the public internet; false for private, loopback, link-local and unique local ranges. */
export function isPublicAddress(address: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (v4 !== null) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((o) => o > 255)) return false;
    const value =
      ((octets[0] ?? 0) * 2 ** 24 +
        (octets[1] ?? 0) * 2 ** 16 +
        (octets[2] ?? 0) * 2 ** 8 +
        (octets[3] ?? 0)) >>>
      0;
    return !PRIVATE_V4.some(([base, bits]) => value >>> (32 - bits) === base >>> (32 - bits));
  }
  const v6 = address.toLowerCase();
  if (v6 === "::1" || v6 === "::") return false;
  if (
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    v6.startsWith("fe8") ||
    v6.startsWith("fe9") ||
    v6.startsWith("fea") ||
    v6.startsWith("feb")
  ) {
    return false;
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped?.[1] !== undefined) return isPublicAddress(mapped[1]);
  return v6.includes(":");
}

export interface DispatchOptions {
  readonly store: WebhookStore;
  readonly fetch: FetchLike;
  readonly resolve: HostResolver;
  readonly limit?: number;
  readonly timeoutMs?: number;
  readonly userAgent?: string;
}

export interface DispatchSummary {
  readonly attempted: number;
  readonly delivered: number;
  readonly failed: number;
}

/**
 * Posts claimed deliveries. Each host is resolved first and refused if any address is private (SSRF,
 * Section 9); redirects are not followed; a request times out after 10 seconds. Every outcome is
 * recorded, so the database applies the 72-hour exponential backoff.
 */
export async function dispatchWebhooks(options: DispatchOptions): Promise<DispatchSummary> {
  const deliveries = await options.store.claim(options.limit ?? 25);
  let delivered = 0;
  let failed = 0;
  for (const delivery of deliveries) {
    let status: number | null = null;
    let error: string | null = null;
    try {
      const host = new URL(delivery.url).hostname.replace(/^\[|\]$/g, "");
      const addresses = /^[\d.]+$|:/.test(host) ? [host] : await options.resolve(host);
      if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
        error = "Refused: the endpoint host resolves to a private address.";
      } else {
        const response = await options.fetch(delivery.url, {
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
          headers: {
            "Content-Type": "application/json",
            "User-Agent": options.userAgent ?? "XOS-Webhooks/1",
            "XOS-Signature": delivery.signature,
            "XOS-Delivery": delivery.deliveryId,
            "XOS-Event": delivery.eventType,
          },
          body: delivery.body,
        });
        status = response.status;
        if (status < 200 || status > 299) error = `HTTP ${status}`;
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const outcome = await options.store.record(delivery.deliveryId, status, error);
    if (outcome === "Delivered") delivered += 1;
    else failed += 1;
  }
  return { attempted: deliveries.length, delivered, failed };
}
