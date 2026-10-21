import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageSetting } from "../i18n/negotiate";

/**
 * locale.language at organization scope (A65-001): inside an org's routes (the proxy names the route's org in
 * a request header) the viewer's resolved language takes part in locale negotiation, and an org that locks
 * es-US renders Atlas in Spanish whatever the device chose.
 */
const request = vi.hoisted(() => ({
  org: undefined as string | undefined,
  cookie: undefined as string | undefined,
  setting: null as LanguageSetting | null,
  asked: [] as string[],
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "xos-locale" && request.cookie !== undefined ? { value: request.cookie } : undefined,
  }),
  headers: async () =>
    new Headers({
      "accept-language": "en-US",
      ...(request.org === undefined ? {} : { "x-xos-route-org": request.org }),
    }),
}));
vi.mock("next-intl/server", () => ({ getRequestConfig: <T>(create: T) => create }));
vi.mock("@/lib/shell/org-language", () => ({
  orgLanguage: async (slug: string) => {
    request.asked.push(slug);
    return request.setting;
  },
}));

const { negotiatedLocale } = await import("../i18n/request");

describe("locale negotiation inside an org (locale.language)", () => {
  beforeEach(() => {
    request.org = undefined;
    request.cookie = undefined;
    request.setting = null;
    request.asked = [];
  });

  it("renders in the language the org locks, over the device's choice", async () => {
    request.org = "northwind-live";
    request.cookie = "en-US";
    request.setting = { value: "es-US", source: "Organization", locked: true };
    expect(await negotiatedLocale()).toBe("es-US");
    expect(request.asked).toEqual(["northwind-live"]);
  });

  it("uses the org's unlocked language when this device chose none", async () => {
    request.org = "northwind-live";
    request.setting = { value: "es-US", source: "Organization", locked: false };
    expect(await negotiatedLocale()).toBe("es-US");
    request.cookie = "en-US";
    expect(await negotiatedLocale()).toBe("en-US");
  });

  it("reads no org setting outside an org's routes", async () => {
    request.setting = { value: "es-US", source: "Organization", locked: true };
    expect(await negotiatedLocale()).toBe("en-US");
    expect(request.asked).toEqual([]);
  });
});
