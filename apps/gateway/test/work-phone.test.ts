import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A139: a work phone saved on Gateway's Preferences is read in the person's region with toE164 and stored in
 * E.164, the form the 2321 check requires; anything that is not a phone number is refused before it is sent.
 */

const request = vi.hoisted(() => ({
  locale: "en-US",
  saved: [] as { key: string; value: unknown }[],
}));

vi.mock("next-intl/server", () => ({ getLocale: async () => request.locale }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: async () => ({}) }));
vi.mock("@/lib/shell/actions", () => ({ setLocale: async () => undefined }));
vi.mock("@xos/data/settings", () => ({
  setPersonalSetting: async (_db: unknown, input: { key: string; value: unknown }) => {
    request.saved.push(input);
    return { ok: true, data: "v1" };
  },
  clearPersonalSetting: async () => ({ ok: true, data: null }),
}));

const { savePersonalSettingAction } = await import("../lib/actions/settings");

function phone(value: string): FormData {
  const data = new FormData();
  data.set("key", "workforce.work_phone");
  data.set("value", value);
  return data;
}

describe("the work phone on Gateway (workforce.work_phone)", () => {
  beforeEach(() => {
    request.locale = "en-US";
    request.saved = [];
  });

  it("stores a national number in E.164, read in the person's region", async () => {
    request.locale = "es-US";
    expect(await savePersonalSettingAction({}, phone("(305) 555-0142"))).toEqual({ saved: 1 });
    expect(request.saved).toEqual([{ key: "workforce.work_phone", value: "+13055550142" }]);
  });

  it("keeps an international number's own country", async () => {
    expect(await savePersonalSettingAction({}, phone("+39 347 123 4567"))).toEqual({ saved: 1 });
    expect(request.saved).toEqual([{ key: "workforce.work_phone", value: "+393471234567" }]);
  });

  it("refuses what is not a phone number without sending it", async () => {
    expect(await savePersonalSettingAction({}, phone("desk 4412"))).toEqual({ error: "phone" });
    expect(request.saved).toEqual([]);
  });
});
