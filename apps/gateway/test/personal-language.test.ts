import type { ResolvedSetting } from "@xos/data/settings";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { negotiateLocale } from "../i18n/negotiate";
import { ownLanguageOf } from "../lib/shell/personal-settings";
import type * as PersonalSettings from "../lib/shell/personal-settings";

/**
 * locale.language is a personal setting Gateway shows on Preferences (Section 4.5.6, A65-001). Gateway renders in
 * the person's own language, saved on any device or shell, when this device chose none, and a language saved on
 * Preferences applies on this device at once.
 */
const request = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  own: null as string | null,
  asked: 0,
  saved: [] as { key: string; value: unknown }[],
  locales: [] as string[],
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "xos-locale" && request.cookie !== undefined ? { value: request.cookie } : undefined,
  }),
  headers: async () => new Headers({ "accept-language": "en-US" }),
}));
vi.mock("next-intl/server", () => ({ getRequestConfig: <T>(create: T) => create }));
vi.mock("@/lib/shell/personal-settings", async (original) => ({
  ...(await original<typeof PersonalSettings>()),
  ownLanguage: async () => {
    request.asked += 1;
    return request.own;
  },
}));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: async () => ({}) }));
vi.mock("@xos/data/settings", () => ({
  setPersonalSetting: async (_db: unknown, input: { key: string; value: unknown }) => {
    request.saved.push(input);
    return { ok: true, data: "v1" };
  },
  clearPersonalSetting: async () => ({ ok: true, data: null }),
}));
vi.mock("@/lib/shell/actions", () => ({
  setLocale: async (locale: string) => {
    request.locales.push(locale);
  },
}));

const { negotiatedLocale } = await import("../i18n/request");
const { savePersonalSettingAction } = await import("../lib/actions/settings");

const setting = (value: string, source: ResolvedSetting["source"]) =>
  new Map<string, ResolvedSetting>([
    ["locale.language", { key: "locale.language", value, source, locked: false }],
  ]);

describe("the person's own language in Gateway (locale.language)", () => {
  beforeEach(() => {
    request.cookie = undefined;
    request.own = null;
    request.asked = 0;
    request.saved = [];
    request.locales = [];
  });

  it("puts this device's choice first, then the person's own language, then the browser", () => {
    expect(
      negotiateLocale({ cookie: "en-US", acceptLanguage: "en", production: true, own: "es-US" }),
    ).toBe("en-US");
    expect(negotiateLocale({ acceptLanguage: "en", production: true, own: "es-US" })).toBe("es-US");
    // A Beta locale the person chose applies (ADR 0053); a language XOS does not ship leaves it to the browser.
    expect(negotiateLocale({ acceptLanguage: "es", production: true, own: "fr-FR" })).toBe("fr-FR");
    expect(negotiateLocale({ acceptLanguage: "es", production: true, own: "nl-NL" })).toBe("es-US");
    expect(negotiateLocale({ acceptLanguage: "es", production: true, own: "en-XA" })).toBe("es-US");
  });

  it("takes the person's own value, never the platform default", () => {
    expect(ownLanguageOf(setting("es-US", "Personal"))).toBe("es-US");
    expect(ownLanguageOf(setting("en-US", "Default"))).toBeNull();
    expect(ownLanguageOf(new Map())).toBeNull();
  });

  it("renders in the person's own language when this device chose none", async () => {
    request.own = "es-US";
    expect(await negotiatedLocale()).toBe("es-US");
    expect(request.asked).toBe(1);
  });

  it("reads no personal setting when this device chose a language", async () => {
    request.cookie = "en-US";
    request.own = "es-US";
    expect(await negotiatedLocale()).toBe("en-US");
    expect(request.asked).toBe(0);
  });

  it("applies a language saved on Preferences on this device at once", async () => {
    const form = (key: string, value: string) => {
      const data = new FormData();
      data.set("key", key);
      data.set("value", value);
      return data;
    };
    expect(await savePersonalSettingAction({}, form("locale.language", "es-US"))).toEqual({
      saved: 1,
    });
    expect(request.saved).toEqual([{ key: "locale.language", value: "es-US" }]);
    expect(request.locales).toEqual(["es-US"]);
    await savePersonalSettingAction({}, form("locale.units", "metric"));
    expect(request.locales).toEqual(["es-US"]);
  });
});
