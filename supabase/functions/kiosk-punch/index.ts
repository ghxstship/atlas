// Kiosk PIN service (A03 carry-over, ADR 0016): a shared kiosk posts its device key, the member and the PIN.
// app.kiosk_punch verifies them through private.verify_kiosk_pin, rate-limits failures per device and
// clocks the member in or out. Refusals come back as codes, never as data about other members.
import { z } from "zod";
import { kioskPunch } from "../_vendor/xos-platform.js";
import { json, serve, serviceDb } from "../_shared/runtime.ts";

const body = z.object({
  deviceKey: z.string().min(8).max(200),
  membershipId: z.uuid(),
  pin: z.string().regex(/^[0-9]{4,8}$/),
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
  const result = await kioskPunch(serviceDb(), parsed.data);
  if (result.refusal !== null) return json(422, { refusal: "REFUSE", reason: result.refusal });
  return json(200, { time_entry_id: result.timeEntryId, punch: result.punch });
});
