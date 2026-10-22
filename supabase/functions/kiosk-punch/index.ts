// Kiosk PIN service for A17 Compass: a shared kiosk posts its device key, the member, the PIN and the punch
// (client punch id as UUID v7, kind, device time, and for punches queued offline the monotonic offset since
// the punch, plus an optional photo). app.kiosk_punch verifies the PIN, rate-limits failures per device and
// records the punch through app.record_punch, idempotent on the punch id. Refusals come back as codes,
// never as data about other members. A device key that names no live kiosk (never registered, revoked or
// retired) is refused as kiosk_device_unregistered before the member or PIN are looked at (migration 1420),
// so the kiosk can say it needs re-keying instead of counting down a worker's PIN attempts.
//
// The function loads no npm package (A85): the body is checked by the platform's own parser and the
// database is reached over PostgREST with fetch, so a kiosk's cold start stays well inside the CPU limit.
import { kioskPunch, parseKioskPunchRequest } from "../_vendor/kiosk-punch.js";
import { json, serve, serviceDb } from "../_shared/runtime.ts";

serve(async (request) => {
  if (request.method !== "POST")
    return json(405, {
      type: "/problems/method-not-allowed",
      title: "Method not allowed",
      status: 405,
    });
  const input = parseKioskPunchRequest(await request.json().catch(() => null));
  if (input === null) return json(422, { refusal: "REFUSE", reason: "kiosk_request_invalid" });
  const result = await kioskPunch(serviceDb(), input);
  if (result.refusal !== null)
    return json(422, { refusal: "REFUSE", reason: result.refusal, punch_id: input.punchId });
  return json(200, {
    punch_id: result.punchId,
    punch_kind: result.punchKind,
    time_entry_id: result.timeEntryId,
    effective_at: result.effectiveAt,
    skew_flagged: result.skewFlagged,
  });
});
