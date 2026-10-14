/**
 * Client-generated UUIDv7 identifiers.
 *
 * Every offline insert uses one as the row's primary key, so the id doubles as the idempotency key: a
 * replayed upload hits the primary key and is treated as already applied (ADR 0002 keys, Section 13).
 * Time-ordered ids also keep the outbox and local tables in creation order.
 */

export type RandomSource = (bytes: Uint8Array) => Uint8Array;

const defaultRandom: RandomSource = (bytes) => globalThis.crypto.getRandomValues(bytes);

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Returns a version 7 UUID for the given wall time in milliseconds. */
export function uuidv7(nowMs: number = Date.now(), random: RandomSource = defaultRandom): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new RangeError("uuidv7 needs a non-negative integer millisecond timestamp");
  }
  const bytes = random(new Uint8Array(16));
  let ms = nowMs;
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isUuidv7(value: string): boolean {
  return UUID_V7.test(value);
}

/** Wall time in milliseconds encoded in a UUIDv7. */
export function uuidv7Time(value: string): number {
  if (!isUuidv7(value)) throw new TypeError("not a UUIDv7");
  return Number.parseInt(value.replace(/-/g, "").slice(0, 12), 16);
}
