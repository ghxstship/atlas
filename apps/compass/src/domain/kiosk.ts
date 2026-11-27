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
 *
 * One tap, one punch (4.19): a punch is one id from the tap to the server's answer. The kiosk sends one
 * punch at a time (`singleFlight`), every send has a time limit (`KIOSK_SEND_TIMEOUT_MS`), and a punch
 * the server did not answer is queued under the same id, so app.record_punch takes it once however often
 * it arrives. Only a rejected PIN spends a PIN attempt; every other refusal says what it is.
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
  | {
      readonly kind: "photo";
      readonly worker: RosterEntry;
      readonly digits: string;
      /** The PIN attempts left when the photo step began, so a wrong PIN returns to the keypad. */
      readonly attemptsLeft: number;
    }
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

export type KioskRefusal =
  | "pin-invalid"
  | "pin-locked"
  /** The device key names no live kiosk (migration 1420): the device needs a new key. */
  | "device-unregistered"
  | "request-invalid"
  /** The org has not turned kiosks on (time.kiosk_enabled). */
  | "kiosk-disabled"
  /** The project asks for a photo on every kiosk punch (time.photo_on_punch) and none came. */
  | "photo-required"
  /** A clock-in for someone the server has clocked in (punch_already_in): nothing was recorded twice. */
  | "already-in"
  /** A clock-out or break for someone the server has not clocked in (punch_not_in). */
  | "not-in"
  /** Too many wrong PINs on this kiosk in 15 minutes (kiosk_rate_limited); no PIN is checked meanwhile. */
  | "rate-limited"
  /** Any other refusal of the punch itself. The PIN was right, so no attempt is spent. */
  | "punch-refused";

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
  return photoOnPunch
    ? { kind: "photo", worker: step.worker, digits: step.digits, attemptsLeft: step.attemptsLeft }
    : step;
}

/** The punch the kiosk offers: clock out when on shift, else clock in. */
export function kioskPunchKind(worker: RosterEntry): PunchKind {
  return worker.onShift ? "Out" : "In";
}

/** The refusals that mean the PIN itself was wrong (app.kiosk_punch answers kiosk_pin_rejected). */
const PIN_REJECTED: readonly string[] = ["kiosk_pin_rejected", "kiosk_pin_invalid"];

/**
 * Maps the Edge Function's refusal reason to the kiosk's refusal. Only a rejected PIN is a wrong PIN: a
 * refusal of the punch (already clocked in, not clocked in, a project or shift rule) came after the PIN
 * was accepted, and once read as a wrong PIN it counted down the worker's attempts to "PIN locked".
 */
export function refusalFromServer(reason: string): KioskRefusal {
  if (PIN_REJECTED.includes(reason)) return "pin-invalid";
  if (reason === "kiosk_pin_locked") return "pin-locked";
  if (reason === "kiosk_rate_limited") return "rate-limited";
  if (reason === DEVICE_UNREGISTERED) return "device-unregistered";
  if (reason === "kiosk_request_invalid") return "request-invalid";
  if (reason === "kiosk_disabled") return "kiosk-disabled";
  if (reason === "punch_photo_required" || reason === "kiosk_photo_uri") return "photo-required";
  if (reason === "punch_already_in") return "already-in";
  if (reason === "punch_not_in") return "not-in";
  return "punch-refused";
}

/** What became of a kiosk punch: recorded, refused with the server's reason, or kept in the queue. */
export type KioskOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: "queued" };

export function afterServer(step: KioskStep, outcome: KioskOutcome): KioskStep {
  if (step.kind !== "pin" && step.kind !== "photo") return step;
  const punch = kioskPunchKind(step.worker);
  if (outcome.ok === true) return { kind: "done", worker: step.worker, punch, verified: true };
  if (outcome.ok === "queued") return { kind: "done", worker: step.worker, punch, verified: false };
  const reason = refusalFromServer(outcome.reason);
  if (reason === "device-unregistered") return { kind: "unregistered" };
  // A wrong PIN returns to the keypad with one attempt fewer, from the photo step as well: the photo is
  // taken again with the right PIN, and one typing mistake is not shown as a locked PIN.
  if (reason === "pin-invalid" && step.attemptsLeft > 1) {
    return { kind: "pin", worker: step.worker, digits: "", attemptsLeft: step.attemptsLeft - 1 };
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
  /** The photo taken on this device, uploaded to field-media before the punch is sent. */
  readonly photo?: { readonly path: string; readonly localUri: string } | null;
}

/**
 * Where a kiosk punch photo is stored in the field-media bucket (migration 1328):
 * <org_id>/kiosk-punches/<project_id>/<punch id>.jpg.
 */
export function kioskPhotoPath(orgId: string, projectId: string, punchId: string): string {
  return `${orgId}/kiosk-punches/${projectId}/${punchId}.jpg`;
}

/** The URI a punch carries for a stored field-media photo. */
export function storedPhotoUri(path: string): string {
  return `storage://field-media/${path}`;
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
      ...(input.photo
        ? {
            photoUri: storedPhotoUri(input.photo.path),
            storage_path: input.photo.path,
            local_uri: input.photo.localUri,
          }
        : input.photoUri
          ? { photoUri: input.photoUri }
          : {}),
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

/** How many times the kiosk sends a punch before it keeps it in the queue instead. */
export const KIOSK_SEND_ATTEMPTS = 3;

/**
 * How long the kiosk waits for one answer. A request that hangs (a function still starting, a stalled
 * connection) is given up after this, and the punch is kept in the queue under the same id, so the
 * worker is told within seconds instead of standing at a keypad that shows nothing.
 */
export const KIOSK_SEND_TIMEOUT_MS = 10_000;

/** Raised when one send took longer than its time limit. The kiosk treats it as no answer and queues. */
export class KioskSendTimeout extends Error {
  constructor(ms: number) {
    super(`The kiosk punch was not answered within ${ms} ms.`);
    this.name = "KioskSendTimeout";
  }
}

/**
 * Runs one request with a time limit. The request gets an abort signal, which is aborted when the limit
 * passes; the returned promise rejects with KioskSendTimeout then, whether or not the request honors
 * the signal.
 */
export async function withSendTimeout<R>(
  request: (signal: AbortSignal) => Promise<R>,
  timeoutMs: number = KIOSK_SEND_TIMEOUT_MS,
): Promise<R> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new KioskSendTimeout(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([request(controller.signal), limit]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends a kiosk punch, sending it again when the server could not answer (a 5xx: an Edge Function worker
 * that hit its CPU limit while starting answers 546, a cold one 503 or 504). The punch id makes a repeat a
 * duplicate, never a second punch, so the PIN verdict comes back while the worker still stands at the
 * kiosk instead of a "saved, checked later" that was never about being offline (A66). A network error and
 * any other status are returned at once: the caller queues on the first and shows the second.
 */
export async function sendKioskPunch<R extends { readonly status: number }>(
  send: () => Promise<R>,
  attempts: number = KIOSK_SEND_ATTEMPTS,
  pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<R> {
  let response = await send();
  for (let attempt = 1; attempt < attempts && response.status >= 500; attempt += 1) {
    await pause(500 * attempt);
    response = await send();
  }
  return response;
}

/** The part of a fetch Response the kiosk reads. */
export interface KioskResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly json: () => Promise<unknown>;
}

export interface KioskSubmitDeps {
  /** False when the device knows it is offline: the punch is queued without a request. */
  readonly online: boolean;
  /** Keeps the punch in the offline queue, which uploads it under the same punch id. */
  readonly enqueue: (punch: MutationInput) => Promise<unknown>;
  /**
   * True when the queue still holds an earlier punch of the same worker. The new punch then queues
   * behind it, because the queue uploads in order: sent at once, a clock-out could reach the server
   * before the queued clock-in it follows and be refused as not clocked in.
   */
  readonly queuedAhead?: () => Promise<boolean>;
  /** Posts the punch body to the kiosk-punch Edge Function. */
  readonly post: (body: Record<string, unknown>, signal: AbortSignal) => Promise<KioskResponse>;
  /**
   * Stores the punch photo before the punch is sent; false when it could not be stored yet. Left out
   * when the punch has no photo.
   */
  readonly storePhoto?: () => Promise<boolean>;
  readonly timeoutMs?: number;
  readonly attempts?: number;
  readonly pause?: (ms: number) => Promise<void>;
}

/**
 * Whether the queue holds a punch of this worker still waiting to upload. A punch in conflict is left
 * out: it waits for a person to resolve it, and a punch queued behind it would wait as well.
 */
export function hasQueuedPunch(
  queue: readonly {
    readonly table: string;
    readonly status: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }[],
  membershipId: string,
): boolean {
  return queue.some(
    (m) =>
      m.table === "kiosk_punches" &&
      m.status === "pending" &&
      m.payload["membershipId"] === membershipId,
  );
}

/**
 * One kiosk punch from the tap to its outcome. Exactly one of three things happens to the punch, always
 * under the id it was built with:
 *   - the server recorded it (`ok: true`);
 *   - the server refused it and nothing was recorded (`ok: false`, with the reason);
 *   - no usable answer came (offline, a network error, a time limit, three 5xx answers, an answer that
 *     is neither), or an earlier punch of the same worker is still queued: it is kept in the queue (`ok: "queued"`). If the server had in fact recorded it before
 *     the answer was lost, the queued upload is a replay of the same id and app.record_punch returns the
 *     punch it already has.
 * It never throws for a failed send, so the screen always has something to show.
 */
export async function submitKioskPunch(
  punch: MutationInput,
  deps: KioskSubmitDeps,
): Promise<KioskOutcome> {
  const queued = async (): Promise<KioskOutcome> => {
    await deps.enqueue(punch);
    return { ok: "queued" };
  };
  if (!deps.online) return queued();
  try {
    if (deps.queuedAhead && (await deps.queuedAhead())) return await queued();
    // The photo could not be stored yet: the punch queues with it and both upload together.
    if (deps.storePhoto && !(await deps.storePhoto())) return await queued();
    const body = { ...punch.payload, monotonicOffsetMs: 0 };
    const response = await sendKioskPunch(
      () => withSendTimeout((signal) => deps.post(body, signal), deps.timeoutMs),
      deps.attempts,
      deps.pause,
    );
    if (response.ok) return { ok: true };
    if (response.status === 422) {
      const answer = (await response.json().catch(() => null)) as { reason?: unknown } | null;
      const reason = answer?.reason;
      return { ok: false, reason: typeof reason === "string" ? reason : "kiosk_request_invalid" };
    }
    return await queued();
  } catch {
    // The network dropped or the time limit passed: the punch queues with its id, so the upload cannot
    // double it.
    return queued();
  }
}

/**
 * Lets one task run at a time. A second call while the first is running does nothing and resolves to
 * undefined: a second tap on Clock In while the first punch is on its way must not build a second punch
 * with a new id.
 */
export function singleFlight(): {
  readonly run: <T>(task: () => Promise<T>) => Promise<T | undefined>;
  readonly busy: () => boolean;
} {
  let running = false;
  return {
    busy: () => running,
    run: async (task) => {
      if (running) return undefined;
      running = true;
      try {
        return await task();
      } finally {
        running = false;
      }
    },
  };
}

/** The kiosk wakes the kiosk-punch function at most this often. */
export const KIOSK_WARM_EVERY_MS = 60_000;

/**
 * Wakes the kiosk-punch Edge Function while a worker types a PIN, so the punch that follows is answered
 * by a worker that has already started. At most one ping per `everyMs`; a ping that fails is ignored,
 * because the punch itself is sent again on a 5xx and queued when no answer comes.
 */
export function kioskWarmer(
  ping: () => Promise<unknown>,
  now: () => number = Date.now,
  everyMs: number = KIOSK_WARM_EVERY_MS,
): () => void {
  let last: number | null = null;
  return () => {
    const at = now();
    if (last !== null && at - last < everyMs) return;
    last = at;
    void ping().catch(() => undefined);
  };
}

/** What the kiosk learned about who is clocked in from its own punches, newer than the synced rows. */
export type ShiftKnowledge = Readonly<
  Record<string, { readonly onShift: boolean; readonly atMs: number }>
>;

/** How long the kiosk trusts what it learned when the synced rows never come to agree with it. */
export const KIOSK_KNOWLEDGE_MS = 12 * 60 * 60_000;

/**
 * What a punch's outcome says about the worker. The synced time entries arrive after the punch, so until
 * they do the kiosk would offer the same action again: a worker who clocked in a minute ago was offered
 * Clock In, and the clock-out they meant was refused. A recorded or queued In means on shift and an Out
 * off shift; "already clocked in" and "not clocked in" from the server say so directly. Breaks and other
 * refusals say nothing.
 */
export function learnShift(
  known: ShiftKnowledge,
  membershipId: string,
  punch: PunchKind,
  outcome: KioskOutcome,
  nowMs: number,
): ShiftKnowledge {
  let onShift: boolean | null = null;
  if (outcome.ok === false) {
    const refusal = refusalFromServer(outcome.reason);
    if (refusal === "already-in") onShift = true;
    if (refusal === "not-in") onShift = false;
  } else if (punch === "In") onShift = true;
  else if (punch === "Out") onShift = false;
  if (onShift === null) return known;
  return { ...known, [membershipId]: { onShift, atMs: nowMs } };
}

/**
 * The roster with what the kiosk learned laid over the synced rows, and that knowledge with everything
 * dropped that the synced rows now agree with or that is older than KIOSK_KNOWLEDGE_MS. `known` is
 * returned as it came when nothing was dropped.
 */
export function rosterWithKnowledge(
  roster: readonly RosterEntry[],
  known: ShiftKnowledge,
  nowMs: number,
): { readonly roster: RosterEntry[]; readonly known: ShiftKnowledge } {
  const kept: Record<string, { readonly onShift: boolean; readonly atMs: number }> = {};
  const synced = new Map(roster.map((r) => [r.membershipId, r.onShift]));
  for (const [id, fact] of Object.entries(known)) {
    if (nowMs - fact.atMs >= KIOSK_KNOWLEDGE_MS) continue;
    if (synced.get(id) === fact.onShift) continue;
    kept[id] = fact;
  }
  const same = Object.keys(kept).length === Object.keys(known).length;
  return {
    roster: roster.map((r) => {
      const fact = kept[r.membershipId];
      return fact ? { ...r, onShift: fact.onShift } : r;
    }),
    known: same ? known : kept,
  };
}
