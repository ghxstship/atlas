import { describe, expect, it } from "vitest";
import {
  getMyNotificationMatrix,
  getMyNotificationSettings,
  getMySmsStatus,
  getOrgNotificationDefaults,
  recordMySmsConsent,
  saveMyNotificationPreferences,
  saveMyNotificationSettings,
  saveOrgNotificationDefaults,
} from "../src/notification-settings.ts";
import { commercialClient, errorResponse, okResponse } from "./commercial-fake.ts";

describe("notification settings (1362)", () => {
  it("reads the member's resolved matrix and drops channels it does not know", async () => {
    const { db, calls } = commercialClient({
      "rpc:my_notification_matrix": [
        okResponse([
          {
            category_code: "safety",
            urgent: true,
            sort_order: 7,
            channel: "Push",
            enabled: true,
            org_default: true,
            locked: true,
            chosen: false,
          },
          {
            category_code: "safety",
            urgent: true,
            sort_order: 7,
            channel: "Fax",
            enabled: true,
            org_default: true,
            locked: false,
            chosen: false,
          },
        ]),
        errorResponse("42501", "denied"),
      ],
    });
    expect(await getMyNotificationMatrix(db, "org-1")).toEqual({
      ok: true,
      data: [
        {
          category: "safety",
          urgent: true,
          channel: "Push",
          enabled: true,
          orgDefault: true,
          locked: true,
          chosen: false,
        },
      ],
    });
    expect(calls[0]?.steps).toContainEqual(["args", [{ p_org_id: "org-1" }]]);
    expect((await getMyNotificationMatrix(db, "org-1")).ok).toBe(false);
  });

  it("saves choices and surfaces the mandatory refusal", async () => {
    const { db, calls } = commercialClient({
      "rpc:set_my_notification_preferences": [
        okResponse(1),
        errorResponse(
          "XR001",
          "notification_category_mandatory: Your organization made this category mandatory",
        ),
      ],
    });
    const choice = { category: "feed", channel: "Email" as const, enabled: false };
    expect(await saveMyNotificationPreferences(db, "org-1", [choice])).toEqual({
      ok: true,
      data: 1,
    });
    expect(calls[0]?.steps).toContainEqual([
      "args",
      [{ p_org_id: "org-1", p_preferences: [choice] }],
    ]);
    const refused = await saveMyNotificationPreferences(db, "org-1", [choice]);
    expect(refused.ok ? null : refused.error.kind).toBe("refusal");
  });

  it("reads and saves quiet hours, the time zone and the digest", async () => {
    const { db, calls } = commercialClient({
      "from:notification_settings": [
        okResponse({
          time_zone: "America/Chicago",
          quiet_hours_start: "21:00:00",
          quiet_hours_end: "07:00:00",
          digest_frequency: "Daily",
          digest_hour: 8,
        }),
        okResponse(null),
        errorResponse("08006", "down"),
      ],
      "rpc:set_my_notification_settings": [
        okResponse(null),
        errorResponse("XR001", "time_zone_unknown: Not a zone"),
      ],
    });
    expect(await getMyNotificationSettings(db, "org-1")).toEqual({
      ok: true,
      data: {
        timeZone: "America/Chicago",
        quietHoursStart: "21:00",
        quietHoursEnd: "07:00",
        digestFrequency: "Daily",
        digestHour: 8,
      },
    });
    expect(await getMyNotificationSettings(db, "org-1")).toEqual({ ok: true, data: null });
    expect((await getMyNotificationSettings(db, "org-1")).ok).toBe(false);
    const settings = {
      timeZone: "UTC",
      quietHoursStart: null,
      quietHoursEnd: null,
      digestFrequency: "Off" as const,
      digestHour: 8,
    };
    expect(await saveMyNotificationSettings(db, "org-1", settings)).toEqual({
      ok: true,
      data: null,
    });
    expect(calls.at(-1)?.steps).toContainEqual([
      "args",
      [
        {
          p_org_id: "org-1",
          p_time_zone: "UTC",
          p_quiet_hours_start: null,
          p_quiet_hours_end: null,
          p_digest_frequency: "Off",
          p_digest_hour: 8,
        },
      ],
    ]);
    expect((await saveMyNotificationSettings(db, "org-1", settings)).ok).toBe(false);
  });

  it("reads and saves org defaults and mandatory categories", async () => {
    const { db, calls } = commercialClient({
      "from:org_notification_defaults": [
        okResponse([
          { category_code: "feed", channel: "Email", enabled: false },
          { category_code: "feed", channel: "Pager", enabled: true },
        ]),
        errorResponse("08006", "down"),
        okResponse([]),
      ],
      "from:org_mandatory_notification_categories": [
        okResponse([{ category_code: "safety" }]),
        okResponse([]),
        errorResponse("08006", "down"),
      ],
      "rpc:set_org_notification_defaults": [okResponse(null), errorResponse("42501", "denied")],
    });
    expect(await getOrgNotificationDefaults(db, "org-1")).toEqual({
      ok: true,
      data: {
        defaults: [{ category: "feed", channel: "Email", enabled: false }],
        mandatory: ["safety"],
      },
    });
    expect((await getOrgNotificationDefaults(db, "org-1")).ok).toBe(false);
    expect((await getOrgNotificationDefaults(db, "org-1")).ok).toBe(false);
    const input = {
      defaults: [{ category: "safety", channel: "SMS" as const, enabled: true }],
      mandatory: ["safety"],
    };
    expect(await saveOrgNotificationDefaults(db, "org-1", input)).toEqual({ ok: true, data: null });
    expect(calls.at(-1)?.steps).toContainEqual([
      "args",
      [{ p_org_id: "org-1", p_defaults: input.defaults, p_mandatory: ["safety"] }],
    ]);
    expect((await saveOrgNotificationDefaults(db, "org-1", input)).ok).toBe(false);
  });
});

describe("SMS consent (1366)", () => {
  it("reads the verified phone and records consent", async () => {
    const { db, calls } = commercialClient({
      "rpc:my_sms_status": [
        okResponse([{ phone_e164: "+15555550111", may_text: true }]),
        okResponse([]),
        errorResponse("08006", "down"),
      ],
      "rpc:record_my_sms_consent": [
        okResponse(null),
        errorResponse("XR001", "sms_phone_unverified: Verify a phone number"),
      ],
    });
    expect(await getMySmsStatus(db, "org-1")).toEqual({
      ok: true,
      data: { phone: "+15555550111", mayText: true },
    });
    expect(await getMySmsStatus(db, "org-1")).toEqual({
      ok: true,
      data: { phone: null, mayText: false },
    });
    expect((await getMySmsStatus(db, "org-1")).ok).toBe(false);
    expect(await recordMySmsConsent(db, "org-1", true)).toEqual({ ok: true, data: null });
    expect(calls.at(-1)?.steps).toContainEqual(["args", [{ p_org_id: "org-1", p_consent: true }]]);
    const refused = await recordMySmsConsent(db, "org-1", true);
    expect(refused.ok ? null : refused.error.kind).toBe("refusal");
  });
});
