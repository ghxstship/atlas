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

/**
 * IPv4 blocks that are not the public internet (IANA special-purpose registry, RFC 6890 and later):
 * this network, private, shared, loopback, link-local, protocol assignments, documentation, the
 * 6to4 relay, benchmarking, multicast and reserved (with the limited broadcast).
 */
const NON_PUBLIC_V4: readonly [number, number][] = [
  [0x00000000, 8], // 0.0.0.0/8
  [0x0a000000, 8], // 10.0.0.0/8
  [0x64400000, 10], // 100.64.0.0/10
  [0x7f000000, 8], // 127.0.0.0/8
  [0xa9fe0000, 16], // 169.254.0.0/16
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0000000, 24], // 192.0.0.0/24
  [0xc0000200, 24], // 192.0.2.0/24
  [0xc0586300, 24], // 192.88.99.0/24
  [0xc0a80000, 16], // 192.168.0.0/16
  [0xc6120000, 15], // 198.18.0.0/15
  [0xc6336400, 24], // 198.51.100.0/24
  [0xcb007100, 24], // 203.0.113.0/24
  [0xe0000000, 4], // 224.0.0.0/4
  [0xf0000000, 4], // 240.0.0.0/4
];

/** Dotted-quad IPv4 as an unsigned 32-bit number, or null. */
function parseIpv4(address: string): number | null {
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (parts === null) return null;
  const octets = parts.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return null;
  return octets.reduce((value, octet) => value * 256 + octet, 0);
}

function publicV4(value: number): boolean {
  return !NON_PUBLIC_V4.some(
    ([base, bits]) => Math.floor(value / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)),
  );
}

/**
 * An IPv6 address as its eight 16-bit groups, or null. Accepts `::` compression and a dotted IPv4
 * tail (`::ffff:10.0.0.1`); refuses zone ids and anything malformed.
 */
function parseIpv6(address: string): number[] | null {
  if (!/^[0-9a-f:.]+$/i.test(address) || !address.includes(":")) return null;
  let text = address.toLowerCase();
  const tail = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (tail !== null) {
    const v4 = parseIpv4(tail[2] as string);
    if (v4 === null) return null;
    text = `${tail[1]}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string) => (part === "" ? [] : part.split(":"));
  const head = groups(halves[0] as string);
  const rest = halves.length === 2 ? groups(halves[1] as string) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}

/**
 * True for an address on the public internet. Refuses every special-purpose IPv4 block, and for
 * IPv6 anything outside global unicast (2000::/3) or inside its special blocks (protocol
 * assignments and Teredo, documentation, 6to4, SRv6). IPv4 written in IPv6 (mapped `::ffff:`,
 * compatible `::`, NAT64 `64:ff9b::`) is judged by its IPv4 address, in hex as well as dotted
 * form, so `::ffff:7f00:1` is loopback (A69-004).
 */
export function isPublicAddress(address: string): boolean {
  const v4 = parseIpv4(address);
  if (v4 !== null) return publicV4(v4);
  const g = parseIpv6(address);
  if (g === null) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const embedded = g6 * 65536 + g7;
  const zeroHead = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (zeroHead && g5 === 0xffff) return publicV4(embedded); // ::ffff:0:0/96 mapped
  if (zeroHead && g5 === 0) return embedded > 1 && publicV4(embedded); // ::/96 compatible, ::, ::1
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return publicV4(embedded); // 64:ff9b::/96 NAT64
  }
  if (g0 < 0x2000 || g0 > 0x3fff) return false; // outside 2000::/3: ULA, link-local, multicast...
  if (g0 === 0x2001 && g1 < 0x0200) return false; // 2001::/23 protocol assignments, Teredo
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // 2001:db8::/32 documentation
  if (g0 === 0x2002) return false; // 2002::/16 6to4
  if (g0 === 0x3fff && g1 < 0x1000) return false; // 3fff::/20 documentation
  return true;
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
