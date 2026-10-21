/**
 * Kiosk mode (Section 4.3 item 2, Section 4.9 Kiosk, Section 13 Kiosk mode): a shared, supervised device in
 * single-app mode where workers punch with a PIN, with photo capture when the org enables it.
 *
 * PINs are verified only by the server (private.verify_kiosk_pin through the kiosk-punch Edge Function);
 * the device never holds PIN hashes. When the kiosk is offline the punch is queued with the PIN and
 * verified on upload, and the screen says so instead of claiming success.
 *
 * Re-keying (A85): when the server answers that the device key names no live kiosk (retired, revoked or
 * unknown, migration 1420), the kiosk stops taking PINs and says the device is no longer registered. A
 * supervisor whose session the auth server still accepts can forget the stored key, which returns the
 * device to kiosk setup for a new key from Atlas.
 */
import { uuidv7, type MutationInput } from "@xos/sync";
import type { PunchKind } from "./clock";

export interface RosterEntry {
  readonly membershipId: string;
  readonly displayName: string;
  /** Clocked in now, from the synced punches, so the kiosk offers the right action. */
  readonly onShift: boolean;
}

export type KioskStep =
  | { readonly kind: "pick"; readonly query: string }
  | {
      readonly kind: "pin";
      readonly worker: RosterEntry;
      readonly digits: string;
      readonly attemptsLeft: number;
    }
  | { readonly kind: "photo"; readonly worker: RosterEntry; readonly digits: string }
  | {
      readonly kind: "done";
      readonly worker: RosterEntry;
      readonly punch: PunchKind;
      readonly verified: boolean;
    }
  | {
      readonly kind: "refused";
      readonly worker: RosterEntry;
      readonly reason: Exclude<KioskRefusal, "device-unregistered">;
    }
  /** The device key names no live kiosk: the kiosk takes no PINs until a supervisor forgets it. */
  | { readonly kind: "unregistered" };

export type KioskRefusal = "pin-invalid" | "pin-locked" | "device-unregistered" | "request-invalid";

/** The kiosk-punch refusal for a device key that names no live kiosk (migration 1420). */
export const DEVICE_UNREGISTERED = "kiosk_device_unregistered";

export const PIN_MIN = 4;
export const PIN_MAX = 8;
/** The kiosk returns to the picker on its own so the next worker never sees the last one's result. */
export const KIOSK_RESET_MS = 5_000;

export const KIOSK_START: KioskStep = { kind: "pick", query: "" };

/** Name search on the roster: every word typed must start a word of the name. */
export function searchRoster(roster: readonly RosterEntry[], query: string): RosterEntry[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const sorted = [...roster].sort((a, b) => a.displayName.localeCompare(b.displayName));
  if (words.length === 0) return sorted;
  return sorted.filter((r) => {
    const parts = r.displayName.toLowerCase().split(/\s+/);
    return words.every((w) => parts.some((p) => p.startsWith(w)));
  });
}

export function pickWorker(worker: RosterEntry): KioskStep {
  return { kind: "pin", worker, digits: "", attemptsLeft: 5 };
}

export function pressDigit(step: KioskStep, digit: string): KioskStep {
  if (step.kind !== "pin" || !/^\d$/.test(digit) || step.digits.length >= PIN_MAX) return step;
  return { ...step, digits: step.digits + digit };
}

export function backspace(step: KioskStep): KioskStep {
  if (step.kind !== "pin") return step;
  return { ...step, digits: step.digits.slice(0, -1) };
}

export function canSubmitPin(step: KioskStep): boolean {
  return step.kind === "pin" && step.digits.length >= PIN_MIN;
}

/** After the PIN, the photo step when the org enables photo on punch. */
export function afterPin(step: KioskStep, photoOnPunch: boolean): KioskStep {
  if (step.kind !== "pin" || !canSubmitPin(step)) return step;
  return photoOnPunch ? { kind: "photo", worker: step.worker, digits: step.digits } : step;
}

/** The punch the kiosk offers: clock out when on shift, else clock in. */
export function kioskPunchKind(worker: RosterEntry): PunchKind {
  return worker.onShift ? "Out" : "In";
}

/** Maps the Edge Function's refusal reason to the kiosk's refusal. */
export function refusalFromServer(reason: string): KioskRefusal {
  if (reason === "kiosk_pin_locked") return "pin-locked";
  if (reason === DEVICE_UNREGISTERED) return "device-unregistered";
  if (reason === "kiosk_request_invalid") return "request-invalid";
  return "pin-invalid";
}

export function afterServer(
  step: KioskStep,
  outcome:
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: string }
    | { readonly ok: "queued" },
): KioskStep {
  if (step.kind !== "pin" && step.kind !== "photo") return step;
  const punch = kioskPunchKind(step.worker);
  if (outcome.ok === true) return { kind: "done", worker: step.worker, punch, verified: true };
  if (outcome.ok === "queued") return { kind: "done", worker: step.worker, punch, verified: false };
  const reason = refusalFromServer(outcome.reason);
  if (reason === "device-unregistered") return { kind: "unregistered" };
  if (reason === "pin-invalid" && step.kind === "pin" && step.attemptsLeft > 1) {
    return { ...step, digits: "", attemptsLeft: step.attemptsLeft - 1 };
  }
  return {
    kind: "refused",
    worker: step.worker,
    reason: reason === "pin-invalid" ? "pin-locked" : reason,
  };
}

export interface KioskPunchInput {
  readonly deviceKey: string;
  readonly projectId: string | null;
  readonly worker: RosterEntry;
  readonly pin: string;
  readonly deviceAt: string;
  /** Raw monotonic reading and boot at the punch; the uploader turns them into the age at send. */
  readonly monotonicAt: number;
  readonly bootId: string;
  readonly photoUri: string | null;
}

/**
 * The queued kiosk punch for the kiosk-punch Edge Function. The id makes a retried punch a duplicate rather
 * than a second punch; the PIN travels only inside the encrypted local store and the request body.
 */
export function buildKioskPunch(
  input: KioskPunchInput,
  nowMs: number,
  newId: (ms: number) => string = uuidv7,
): MutationInput {
  const id = newId(nowMs);
  return {
    op: "rpc",
    target: "kiosk-punch",
    table: "kiosk_punches",
    rowId: id,
    // The kiosk-punch Edge Function's body: the punch is punchId, and optional fields are left out rather
    // than null (its schema refused both, so every kiosk punch read "That punch could not be read").
    payload: {
      punchId: id,
      deviceKey: input.deviceKey,
      membershipId: input.worker.membershipId,
      pin: input.pin,
      punchKind: kioskPunchKind(input.worker),
      deviceAt: input.deviceAt,
      monotonic_at: input.monotonicAt,
      boot_id: input.bootId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.photoUri ? { photoUri: input.photoUri } : {}),
    },
    policy: "append",
  };
}

export type ForgetKioskOutcome = "forgotten" | "supervisor-required";

export interface ForgetKioskDeps {
  /** True when the signed-in person may run kiosks on this project (kiosk.operate): a supervisor. */
  readonly supervisor: boolean;
  /** The signed-in user's id as the auth server confirms it now (never a cached session), or null. */
  readonly verifiedUserId: () => Promise<string | null>;
  /** Removes the device key from secure storage, which returns the device to kiosk setup. */
  readonly clearKey: () => void | Promise<void>;
}

/**
 * "Forget this kiosk" on an unregistered kiosk. Only a supervisor who is still signed in may clear the
 * key: the session is checked with the auth server, so an expired or revoked session, or a device that
 * is offline, is refused and the key stays.
 */
export async function forgetKiosk(deps: ForgetKioskDeps): Promise<ForgetKioskOutcome> {
  if (!deps.supervisor) return "supervisor-required";
  let userId: string | null;
  try {
    userId = await deps.verifiedUserId();
  } catch {
    userId = null;
  }
  if (userId === null) return "supervisor-required";
  await deps.clearKey();
  return "forgotten";
}
