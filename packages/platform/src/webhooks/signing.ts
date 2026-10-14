/**
 * XOS webhook signatures (ADR 0003): `XOS-Signature: t={unix seconds},v1={hex}` where the hex is
 * HMAC-SHA256 of `{timestamp}.{body}` under the endpoint secret. The database signs deliveries
 * (private.webhook_signature); this module verifies and signs with Web Crypto, for receivers, the SDKs
 * and tests. It runs unchanged in Node and Deno.
 */

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/** The XOS-Signature header value for a body at a time. */
export async function signWebhook(
  secret: string,
  timestamp: number,
  body: string,
): Promise<string> {
  return `t=${timestamp},v1=${await hmacHex(secret, `${timestamp}.${body}`)}`;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface VerifyOptions {
  /** Largest accepted age of the timestamp, in seconds. Five minutes by default. */
  readonly toleranceSeconds?: number;
  /** Current time in unix seconds. */
  readonly now?: number;
}

/**
 * True when the header carries a v1 signature of the body under the secret and its timestamp is within
 * tolerance, which stops replays of old deliveries.
 */
export async function verifyWebhook(
  header: string | null,
  body: string,
  secret: string,
  options: VerifyOptions = {},
): Promise<boolean> {
  if (header === null) return false;
  const parts = new Map<string, string[]>();
  for (const piece of header.split(",")) {
    const [key, value] = piece.split("=", 2);
    if (key === undefined || value === undefined) return false;
    parts.set(key.trim(), [...(parts.get(key.trim()) ?? []), value.trim()]);
  }
  const timestamp = Number(parts.get("t")?.[0]);
  if (!Number.isInteger(timestamp)) return false;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > (options.toleranceSeconds ?? 300)) return false;
  const expected = await hmacHex(secret, `${timestamp}.${body}`);
  return (parts.get("v1") ?? []).some((candidate) => constantTimeEqual(candidate, expected));
}
