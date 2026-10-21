/**
 * Wallet passes in Compass (Section 11.10 item 14, Section 11.13; A65-011 part 4): the person adds their own
 * badge (or a shift pass) to Apple Wallet or Google Wallet, where it works offline and opens from the lock
 * screen. The wallet-pass Edge Function signs the pass; this reads its answer.
 */

export type WalletPlatform = "apple" | "google";
export type WalletKind = "credential" | "shift";

/** The request body the wallet-pass function reads. */
export function walletRequest(
  kind: WalletKind,
  id: string,
  platform: WalletPlatform,
  locale: string,
): { kind: WalletKind; id: string; platform: WalletPlatform; locale: string } {
  return { kind, id, platform, locale };
}

export type WalletOutcome =
  | { readonly kind: "pass"; readonly bytes: Uint8Array }
  | { readonly kind: "link"; readonly url: string }
  | { readonly kind: "refused"; readonly messageKey: string };

/** What the function's answer means, and what to tell the person when it is not a pass. */
export function walletOutcome(
  status: number,
  contentType: string | null,
  body: Uint8Array,
): WalletOutcome {
  if (status === 200 && contentType?.startsWith("application/vnd.apple.pkpass"))
    return { kind: "pass", bytes: body };
  if (status === 200) {
    try {
      const json = JSON.parse(new TextDecoder().decode(body)) as { saveUrl?: unknown };
      if (
        typeof json.saveUrl === "string" &&
        json.saveUrl.startsWith("https://pay.google.com/gp/v/save/")
      )
        return { kind: "link", url: json.saveUrl };
    } catch {
      // Not JSON: a failure below.
    }
  }
  if (status === 503) return { kind: "refused", messageKey: "compass.wallet.notConfigured" };
  if (status === 404 || status === 422)
    return { kind: "refused", messageKey: "compass.wallet.notFound" };
  return { kind: "refused", messageKey: "compass.wallet.failed" };
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 of bytes, for handing a pass to PassKit. */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | (b << 8) | c;
    out += BASE64[(n >> 18) & 63];
    out += BASE64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? BASE64[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? BASE64[n & 63] : "=";
  }
  return out;
}
