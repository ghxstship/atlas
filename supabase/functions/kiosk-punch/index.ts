// Kiosk PIN service for A17 Compass: a shared kiosk posts its device key, the member, the PIN and the punch
// (client punch id as UUID v7, kind, device time, and for punches queued offline the monotonic offset since
// the punch, plus an optional photo). app.kiosk_punch verifies the PIN, rate-limits failures per device and
// records the punch through app.record_punch, idempotent on the punch id. Refusals come back as codes,
// never as data about other members.
import { z } from "zod";
import { PUNCH_KINDS, kioskPunch } from "../_vendor/xos-platform.js";
import { json, serve, serviceDb } from "../_shared/runtime.ts";

const body = z.object({
  deviceKey: z.string().min(8).max(200),
  membershipId: z.uuid(),
  pin: z.string().regex(/^[0-9]{4,8}$/),
  punchId: z.uuidv7(),
  punchKind: z.enum(PUNCH_KINDS),
  deviceAt: z.iso.datetime({ offset: true }),
  monotonicOffsetMs: z.number().int().min(0).max(259_200_000).optional(),
  photoUri: z
    .string()
    .max(1000)
    .regex(/^(storage|https):\/\/\S+$/)
    .optional(),
  projectId: z.uuid().optional(),
});

serve(async (request) => {
  if (request.method !== "POST")
    return json(405, {
      type: "/problems/method-not-allowed",
      title: "Method not allowed",
      status: 405,
    });
  const parsed = body.safeParse(await request.json());
  if (!parsed.success) return json(422, { refusal: "REFUSE", reason: "kiosk_request_invalid" });
  const result = await kioskPunch(serviceDb(), {
    ...parsed.data,
    deviceAt: new Date(parsed.data.deviceAt),
  });
  if (result.refusal !== null)
    return json(422, { refusal: "REFUSE", reason: result.refusal, punch_id: parsed.data.punchId });
  return json(200, {
    punch_id: result.punchId,
    punch_kind: result.punchKind,
    time_entry_id: result.timeEntryId,
    effective_at: result.effectiveAt,
    skew_flagged: result.skewFlagged,
  });
});
