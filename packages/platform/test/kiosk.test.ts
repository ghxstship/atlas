import { describe, expect, it } from "vitest";
import { z } from "zod";
import { KIOSK_REFUSALS, PUNCH_KINDS, parseKioskPunchRequest } from "../src/index.ts";

/** The kiosk-punch function's schema before A85: the parser must accept exactly what it accepted. */
const formerSchema = z.object({
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

const deviceKey = `xkio_${"a1".repeat(32)}`;
const valid = {
  deviceKey,
  membershipId: "01920000-0000-7000-8000-00000000a106",
  pin: "4821",
  punchId: "01a13cc9-7c52-7d3e-8f31-e2d62d58f18a",
  punchKind: "In",
  deviceAt: "2026-10-20T19:00:00.123Z",
};

const variants: Record<string, unknown> = {
  deviceKey: [
    "short",
    "12345678",
    "x".repeat(200),
    "x".repeat(201),
    "",
    42,
    null,
    `xkio_${"f".repeat(64)}`,
  ],
  membershipId: [
    "01920000-0000-7000-8000-00000000A106",
    "00000000-0000-0000-0000-000000000000",
    "ffffffff-ffff-ffff-ffff-ffffffffffff",
    "01920000-0000-0000-8000-00000000a106",
    "01920000-0000-9000-8000-00000000a106",
    "01920000-0000-7000-c000-00000000a106",
    "01920000000070008000-00000000a106",
    " 01920000-0000-7000-8000-00000000a106",
    "not-a-uuid",
    null,
  ],
  pin: ["0000", "12345678", "123", "123456789", "12a4", " 1234", 1234, ""],
  punchId: [
    "01a13cc9-7c52-4d3e-8f31-e2d62d58f18a",
    "01A13CC9-7C52-7D3E-BF31-E2D62D58F18A",
    "01a13cc9-7c52-7d3e-7f31-e2d62d58f18a",
    "00000000-0000-0000-0000-000000000000",
    "01a13cc9-7c52-7d3e-8f31-e2d62d58f18",
  ],
  punchKind: ["In", "Out", "Break Start", "Break End", "in", "Lunch", "", null],
  deviceAt: [
    "2026-10-20T19:00:00Z",
    "2026-10-20T19:00:00+05:30",
    "2026-10-20T19:00:00-23:59",
    "2026-10-20T19:00:00.1+00:00",
    "2026-10-20T19:00Z",
    "2026-10-20T19:00:00",
    "2026-10-20 19:00:00Z",
    "2026-02-29T19:00:00Z",
    "2024-02-29T19:00:00Z",
    "2026-13-01T19:00:00Z",
    "2026-10-20T24:00:00Z",
    "2026-10-20T19:00:00+24:00",
    "2026-10-20T19:00:00.Z",
    "2026-10-20",
    1_760_000_000_000,
  ],
  monotonicOffsetMs: [
    undefined,
    0,
    30_000,
    259_200_000,
    259_200_001,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "30000",
    null,
  ],
  photoUri: [
    undefined,
    "storage://attachments/org/kiosk/p.jpg",
    "https://cdn.example.com/p.jpg",
    "http://cdn.example.com/p.jpg",
    "javascript:alert(1)",
    "storage://has space",
    "storage://",
    `https://${"x".repeat(992)}`,
    `https://${"x".repeat(993)}`,
    null,
  ],
  projectId: [undefined, "01920000-0000-7000-8000-000000001001", "nope", null],
};

function cases(): unknown[] {
  const all: unknown[] = [valid, null, [], "text", 7, {}];
  for (const [field, values] of Object.entries(variants)) {
    for (const value of values as unknown[]) all.push({ ...valid, [field]: value });
  }
  const withoutPin: Record<string, unknown> = { ...valid };
  delete withoutPin["pin"];
  all.push(withoutPin, { ...valid, extra: "kept out", monotonic_at: 12, boot_id: "b1" });
  return all;
}

describe("kiosk-punch request", () => {
  it.each(cases().map((c, i) => [i, c] as const))(
    "case %i is accepted exactly when the former zod schema accepted it",
    (_i, body) => {
      const former = formerSchema.safeParse(body);
      const parsed = parseKioskPunchRequest(body);
      if (!former.success) {
        expect(parsed).toBeNull();
        return;
      }
      expect(parsed).toEqual({ ...former.data, deviceAt: new Date(former.data.deviceAt) });
    },
  );

  it("keeps only the known fields and turns the device time into a date", () => {
    const parsed = parseKioskPunchRequest({
      ...valid,
      monotonicOffsetMs: 30_000,
      photoUri: "storage://attachments/org/kiosk/p.jpg",
      projectId: "01920000-0000-7000-8000-000000001001",
      monotonic_at: 12,
    });
    expect(parsed).toEqual({
      ...valid,
      deviceAt: new Date("2026-10-20T19:00:00.123Z"),
      monotonicOffsetMs: 30_000,
      photoUri: "storage://attachments/org/kiosk/p.jpg",
      projectId: "01920000-0000-7000-8000-000000001001",
    });
    expect(parsed).not.toHaveProperty("monotonic_at");
  });

  it("names the unregistered device refusal apart from the PIN refusal", () => {
    expect(KIOSK_REFUSALS).toContain("kiosk_device_unregistered");
    expect(KIOSK_REFUSALS).toContain("kiosk_pin_rejected");
  });
});
