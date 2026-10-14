/**
 * Kiosk mode (Section 4.3 item 2, Section 4.9 Kiosk, Section 13 Kiosk mode): a shared, supervised device in
 * single-app mode where workers punch with a PIN, with photo capture when the org enables it.
 *
 * PINs are verified only by the server (private.verify_kiosk_pin through the kiosk-punch Edge Function);
 * the device never holds PIN hashes. When the kiosk is offline the punch is queued with the PIN and
 * verified on upload, and the screen says so instead of claiming success.
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
  | { readonly kind: "refused"; readonly worker: RosterEntry; readonly reason: KioskRefusal };

export type KioskRefusal = "pin-invalid" | "pin-locked" | "device-revoked" | "request-invalid";

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
  if (reason === "kiosk_device_revoked" || reason === "kiosk_device_unknown")
    return "device-revoked";
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
  readonly monotonicOffsetMs: number | null;
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
    payload: {
      id,
      deviceKey: input.deviceKey,
      membershipId: input.worker.membershipId,
      pin: input.pin,
      projectId: input.projectId,
      punchKind: kioskPunchKind(input.worker),
      deviceAt: input.deviceAt,
      monotonicOffsetMs: input.monotonicOffsetMs,
      photoUri: input.photoUri,
    },
    policy: "append",
  };
}
