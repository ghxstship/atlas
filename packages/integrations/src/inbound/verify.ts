import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook signature checks for the providers that push to XOS (A83, finding A65-013). Each runs over the raw
 * body before anything is parsed or recorded, compares in constant time, and returns false for anything it
 * cannot verify. Slack and Teams live with the communication connector (verifySlackRequest,
 * verifyTeamsRequest); these cover the accounting and calendar change notices.
 */

/** Constant-time comparison of two strings; false when the lengths differ. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function hmacBase64(key: string | Buffer, body: string): string {
  return createHmac("sha256", key).update(body).digest("base64");
}

/** Xero: `x-xero-signature` is the base64 HMAC-SHA256 of the body under the app's webhook key. */
export function verifyXeroSignature(webhookKey: string, signature: string, body: string): boolean {
  if (webhookKey.length === 0 || signature.length === 0) return false;
  return safeEqual(hmacBase64(webhookKey, body), signature);
}

/** QuickBooks Online: `intuit-signature` is the base64 HMAC-SHA256 of the body under the app's verifier token. */
export function verifyQuickBooksSignature(
  verifierToken: string,
  signature: string,
  body: string,
): boolean {
  if (verifierToken.length === 0 || signature.length === 0) return false;
  return safeEqual(hmacBase64(verifierToken, body), signature);
}

/**
 * Google Calendar push notifications carry the token XOS set when it opened the channel in
 * `X-Goog-Channel-Token`; Microsoft Graph change notifications carry the subscription's `clientState`.
 * Both are compared with the connection's inbound secret.
 */
export function verifySharedToken(expected: string | null, received: string | null): boolean {
  if (expected === null || received === null || expected.length < 16) return false;
  return safeEqual(expected, received);
}
