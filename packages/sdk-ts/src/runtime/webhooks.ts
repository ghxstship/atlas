/**
 * Webhook signatures (ADR 0003): HMAC-SHA256 over `{timestamp}.{body}`, sent as
 * `XOS-Signature: t={unix},v1={hex}`. Uses Web Crypto, so it runs in Node, browsers and edge runtimes.
 */

export const SIGNATURE_HEADER = "XOS-Signature";
export const DEFAULT_TOLERANCE_SECONDS = 300;

export interface ParsedSignature {
  readonly timestamp: number;
  readonly signatures: readonly string[];
}

export type WebhookVerification =
  | { readonly valid: true; readonly timestamp: number }
  | {
      readonly valid: false;
      readonly reason: "malformed_header" | "timestamp_out_of_tolerance" | "signature_mismatch";
    };

const encoder = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await globalThis.crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Parses `t={unix},v1={hex}[,v1={hex}]`. Returns null when the header is malformed. */
export function parseSignatureHeader(header: string): ParsedSignature | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (!key || value === undefined) return null;
    if (key === "t") {
      if (!/^\d+$/.test(value)) return null;
      timestamp = Number(value);
    } else if (key === "v1") {
      if (!/^[0-9a-f]{64}$/.test(value)) return null;
      signatures.push(value);
    }
  }
  return timestamp === null || signatures.length === 0 ? null : { timestamp, signatures };
}

/** Builds the `XOS-Signature` value for a payload. Use it to test your webhook endpoint. */
export async function signWebhookPayload(
  payload: string,
  secret: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  return `t=${timestamp},v1=${await hmacHex(secret, `${timestamp}.${payload}`)}`;
}

/**
 * Verifies a delivery. Pass the raw request body exactly as received; re-serialized JSON
 * will not match.
 */
export async function verifyWebhookSignature(input: {
  readonly payload: string;
  readonly header: string;
  readonly secret: string;
  readonly toleranceSeconds?: number;
  readonly now?: number;
}): Promise<WebhookVerification> {
  const parsed = parseSignatureHeader(input.header);
  if (!parsed) return { valid: false, reason: "malformed_header" };
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - parsed.timestamp) > tolerance) {
    return { valid: false, reason: "timestamp_out_of_tolerance" };
  }
  const expected = await hmacHex(input.secret, `${parsed.timestamp}.${input.payload}`);
  return parsed.signatures.some((s) => constantTimeEqual(s, expected))
    ? { valid: true, timestamp: parsed.timestamp }
    : { valid: false, reason: "signature_mismatch" };
}
