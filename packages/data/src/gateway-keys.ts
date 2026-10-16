/**
 * Gateway display keys (ADR 0006 item 13: opportunity, engagement and thread keys are uppercase
 * display keys that never collide with fixed path words). Engagements, opportunities and threads
 * carry no stored key column, so the key is the row id written in Crockford base 32 behind a kind
 * prefix: `ENG-01JA2B3C4D5E6F7G8H9J0K1M2N`. The encoding is reversible, so no lookup table restates
 * the id (Section 3.15), and it matches the sitemap's display-key pattern.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DISPLAY_KEY_PREFIXES = {
  engagement: "ENG",
  opportunity: "OPP",
  thread: "THR",
  application: "APP",
  payment: "PAY",
} as const;

export type DisplayKeyKind = keyof typeof DISPLAY_KEY_PREFIXES;

/** A uuid as 26 Crockford base 32 characters (128 bits, two pad bits in front). */
export function uuidToBase32(id: string): string {
  if (!UUID.test(id)) throw new Error(`Not a uuid: ${id}`);
  let value = BigInt(`0x${id.replace(/-/g, "")}`);
  let out = "";
  for (let i = 0; i < 26; i++) {
    out = ALPHABET[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

/** The uuid a 26-character Crockford base 32 string encodes; null when it is not one. */
export function base32ToUuid(text: string): string | null {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(text)) return null;
  let value = 0n;
  for (const char of text) value = (value << 5n) | BigInt(ALPHABET.indexOf(char));
  if (value >> 128n !== 0n) return null;
  const hex = value.toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The display key of a row of the given kind. */
export function toDisplayKey(kind: DisplayKeyKind, id: string): string {
  return `${DISPLAY_KEY_PREFIXES[kind]}-${uuidToBase32(id)}`;
}

/** The row id a display key names, when it is a well-formed key of the given kind. */
export function fromDisplayKey(kind: DisplayKeyKind, key: string): string | null {
  const prefix = `${DISPLAY_KEY_PREFIXES[kind]}-`;
  if (!key.startsWith(prefix)) return null;
  return base32ToUuid(key.slice(prefix.length));
}
