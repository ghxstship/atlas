/**
 * The kiosk-punch request (A17 Compass kiosks, A18 PIN service) and its refusal codes. The parser has
 * no dependency, so the kiosk-punch Edge Function boots without zod (A85, cold starts): it accepts
 * exactly what the function's former zod schema accepted, which a differential test checks, and keeps
 * only the known fields.
 */
import { PUNCH_KINDS, type KioskPunchInput, type PunchKind } from "./stores.ts";

/**
 * Refusal codes app.kiosk_punch and the function answer. `kiosk_device_unregistered` (migration 1420)
 * is the same for a device key that never existed and one that was revoked or retired, and is decided
 * before the member or the PIN are looked at, so it tells an unauthenticated caller nothing about
 * members, PINs or other kiosks.
 */
export const KIOSK_REFUSALS = [
  "kiosk_request_invalid",
  "kiosk_device_unregistered",
  "kiosk_rate_limited",
  "kiosk_pin_rejected",
  "kiosk_photo_uri",
  "kiosk_project",
] as const;
export type KioskRefusal = (typeof KIOSK_REFUSALS)[number];

const UUID =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
const UUID_V7 =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$/;
const DATE =
  "(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))";
/** RFC 3339 date-time with seconds and a Z or numeric offset (zod's `iso.datetime({ offset: true })`). */
const DATE_TIME = new RegExp(
  `^${DATE}T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$`,
);
const PIN = /^[0-9]{4,8}$/;
const PHOTO_URI = /^(storage|https):\/\/\S+$/;
const MAX_MONOTONIC_OFFSET_MS = 259_200_000;

function string(value: unknown, test: (text: string) => boolean): value is string {
  return typeof value === "string" && test(value);
}

/**
 * The punch a kiosk posted, or null when any field is missing or malformed. Optional fields must be
 * absent rather than null, as the schema always required.
 */
export function parseKioskPunchRequest(body: unknown): KioskPunchInput | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const b = body as Readonly<Record<string, unknown>>;
  const { deviceKey, membershipId, pin, punchId, punchKind, deviceAt } = b;
  if (!string(deviceKey, (t) => t.length >= 8 && t.length <= 200)) return null;
  if (!string(membershipId, (t) => UUID.test(t))) return null;
  if (!string(pin, (t) => PIN.test(t))) return null;
  if (!string(punchId, (t) => UUID_V7.test(t))) return null;
  if (!string(punchKind, (t) => (PUNCH_KINDS as readonly string[]).includes(t))) return null;
  if (!string(deviceAt, (t) => DATE_TIME.test(t))) return null;
  const input: { -readonly [K in keyof KioskPunchInput]: KioskPunchInput[K] } = {
    deviceKey,
    membershipId,
    pin,
    punchId,
    punchKind: punchKind as PunchKind,
    deviceAt: new Date(deviceAt),
  };
  if (b["monotonicOffsetMs"] !== undefined) {
    const offset = b["monotonicOffsetMs"];
    if (
      typeof offset !== "number" ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > MAX_MONOTONIC_OFFSET_MS
    )
      return null;
    input.monotonicOffsetMs = offset;
  }
  if (b["photoUri"] !== undefined) {
    const photo = b["photoUri"];
    if (!string(photo, (t) => t.length <= 1000 && PHOTO_URI.test(t))) return null;
    input.photoUri = photo;
  }
  if (b["projectId"] !== undefined) {
    const project = b["projectId"];
    if (!string(project, (t) => UUID.test(t))) return null;
    input.projectId = project;
  }
  return input;
}
