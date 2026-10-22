import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { XosClient } from "../src/client.ts";
import {
  CONSENT_BANNER_VERSION,
  ageMetadata,
  confirmMinimumAge,
  minimumAgeConfirmed,
  newVisitorId,
  parseConsent,
  preferenceCookieOptions,
  preferencesAllowed,
  recordCookieConsent,
  sendsGpc,
  serializeConsent,
} from "../src/consent.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

const VISITOR = "0123456789abcdef0123456789abcdef";

describe("the consent cookie", () => {
  it("round-trips the choice and refuses anything else", () => {
    const consent = { visitorId: VISITOR, preferences: true, performance: false, gpc: false };
    expect(serializeConsent(consent)).toBe(`1.${VISITOR}.10.0`);
    expect(parseConsent(serializeConsent(consent))).toEqual(consent);
    expect(parseConsent(undefined)).toBeNull();
    expect(parseConsent(`2.${VISITOR}.10.0`)).toBeNull();
    expect(parseConsent(`1.${VISITOR.toUpperCase()}.10.0`)).toBeNull();
    expect(newVisitorId()).toMatch(/^[0-9a-f]{32}$/);
  });

  it("lets Preferences outlast the visit only with consent and no Global Privacy Control", () => {
    const on = { visitorId: VISITOR, preferences: true, performance: false, gpc: false };
    expect(preferencesAllowed(on, false)).toBe(true);
    expect(preferencesAllowed(on, true)).toBe(false);
    expect(preferencesAllowed({ ...on, gpc: true }, false)).toBe(false);
    expect(preferencesAllowed({ ...on, preferences: false }, false)).toBe(false);
    expect(preferencesAllowed(null, false)).toBe(false);
    expect(preferenceCookieOptions(true, true).maxAge).toBe(31_536_000);
    expect(preferenceCookieOptions(false, true)).toEqual({
      path: "/",
      sameSite: "lax",
      httpOnly: true,
      secure: true,
    });
  });

  it("reads the Global Privacy Control header", () => {
    expect(sendsGpc(new Headers({ "Sec-GPC": "1" }))).toBe(true);
    expect(sendsGpc(new Headers({ "Sec-GPC": "0" }))).toBe(false);
    expect(sendsGpc(new Headers())).toBe(false);
  });

  it("records the Cookie Policy version the registry publishes", () => {
    const registry = readFileSync(new URL("../../../legal/index.yaml", import.meta.url), "utf8");
    const version = /- slug: cookie-policy\n(?:\s+\w+:.*\n)*?\s+version: (\S+)/.exec(registry)?.[1];
    expect(version).toBeDefined();
    expect(CONSENT_BANNER_VERSION).toBe(`cookie-policy ${version}`);
  });
});

describe("recording", () => {
  it("stores the decision through the public consent RPC", async () => {
    const calls: unknown[] = [];
    const db = {
      schema: () => ({
        rpc: async (fn: string, args: unknown) => {
          calls.push({ fn, args });
          return { data: true, error: null };
        },
      }),
    } as unknown as XosClient;
    const result = await recordCookieConsent(
      db,
      { visitorId: VISITOR, preferences: false, performance: false, gpc: true },
      "northwind-live",
    );
    expect(result).toEqual({ ok: true, data: true });
    expect(calls).toEqual([
      {
        fn: "record_cookie_consent",
        args: {
          p_visitor_id: VISITOR,
          p_org_slug: "northwind-live",
          p_functional: false,
          p_analytics: false,
          p_marketing: false,
          p_banner_version: CONSENT_BANNER_VERSION,
          p_global_privacy_control: true,
        },
      },
    ]);
  });
});

describe("16 or older", () => {
  it("carries the ticked box in the sign-up metadata", () => {
    expect(ageMetadata("Gateway")).toEqual({ age_confirmed: "16", signup_surface: "Gateway" });
  });

  it("reads and records the confirmation", async () => {
    const { db, calls } = fakeClient({
      "rpc:minimum_age_confirmed": [okResponse(false)],
      "rpc:confirm_minimum_age": [
        okResponse("2026-10-20T10:00:00Z"),
        errorResponse("42501", "not signed in"),
      ],
    });
    expect(await minimumAgeConfirmed(db)).toEqual({ ok: true, data: false });
    expect(await confirmMinimumAge(db, "Atlas", "203.0.113.5")).toEqual({
      ok: true,
      data: "2026-10-20T10:00:00Z",
    });
    expect(calls[1]?.steps[0]?.[1][0]).toEqual({ p_surface: "Atlas", p_client_ip: "203.0.113.5" });
    expect((await confirmMinimumAge(db, "Atlas", null)).ok).toBe(false);
  });
});
