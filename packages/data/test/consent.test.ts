import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { XosClient } from "../src/client.ts";
import {
  CONSENT_BANNER_VERSION,
  ageMetadata,
  confirmMinimumAge,
  MINIMUM_AGE,
  minimumAgeConfirmed,
  owesAgeAnswer,
  parseLegalStanding,
  readLegalStanding,
  recordAiChoice,
  refuseMinimumAge,
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

describe("18 or older", () => {
  it("carries the answer in the sign-up metadata", () => {
    expect(MINIMUM_AGE).toBe(18);
    expect(ageMetadata("Gateway")).toEqual({ age_confirmed: "18", signup_surface: "Gateway" });
  });

  it("owes an answer only when the server says none was given, and lets a failed read through", async () => {
    const { db } = fakeClient({
      "rpc:minimum_age_confirmed": [
        okResponse(false),
        okResponse(true),
        errorResponse("42501", "not signed in"),
      ],
    });
    expect(await owesAgeAnswer(db)).toBe(true);
    expect(await owesAgeAnswer(db)).toBe(false);
    expect(await owesAgeAnswer(db)).toBe(false);
  });

  it("closes the account of someone who answers under 18, and says why when it cannot", async () => {
    const { db, calls } = fakeClient({
      "rpc:refuse_minimum_age": [
        okResponse({ outcome: "Account Removed" }),
        okResponse({ outcome: "Account Closed" }),
        okResponse({
          outcome: "Account Held",
          reason: "account_delete_on_shift",
          org_name: "Northwind Live",
        }),
        errorResponse("XR001", "age_already_confirmed"),
      ],
    });
    expect(await refuseMinimumAge(db, "Compass")).toEqual({
      ok: true,
      data: { outcome: "Account Removed" },
    });
    expect(calls[0]?.steps[0]?.[1][0]).toEqual({ p_surface: "Compass" });
    expect(await refuseMinimumAge(db, "Atlas")).toEqual({
      ok: true,
      data: { outcome: "Account Closed" },
    });
    expect(await refuseMinimumAge(db, "Atlas")).toEqual({
      ok: true,
      data: {
        outcome: "Account Held",
        reason: "account_delete_on_shift",
        orgName: "Northwind Live",
      },
    });
    expect((await refuseMinimumAge(db, "Atlas")).ok).toBe(false);
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

describe("what a sign-in owes", () => {
  it("reads the standing, and takes anything malformed as owing", async () => {
    const { db } = fakeClient({
      "rpc:my_legal_standing": [
        okResponse({
          age_confirmed: true,
          accepted_documents: ["mobile-eula"],
          worker_terms_apply: false,
          ai_choice: "Allowed",
          ai_disclosure_version: "2026-11-06",
          closing_blocked: true,
        }),
        errorResponse("42501", "not signed in"),
      ],
    });
    expect(await readLegalStanding(db)).toEqual({
      ok: true,
      data: {
        ageConfirmed: true,
        acceptedDocuments: ["mobile-eula"],
        workerTermsApply: false,
        aiChoice: "Allowed",
        aiDisclosureVersion: "2026-11-06",
        closingBlocked: true,
      },
    });
    expect((await readLegalStanding(db)).ok).toBe(false);
    expect(parseLegalStanding({ ai_choice: "Maybe" })).toEqual({
      ageConfirmed: false,
      acceptedDocuments: [],
      workerTermsApply: true,
      aiChoice: null,
      aiDisclosureVersion: null,
      closingBlocked: false,
    });
  });

  it("records the AI choice with the words the person saw", async () => {
    const { db, calls } = fakeClient({
      "rpc:record_ai_choice": [okResponse("2026-11-06T10:00:00Z")],
    });
    expect(
      await recordAiChoice(db, {
        surface: "Compass",
        disclosureVersion: "2026-11-06",
        choice: "Declined",
        clientIp: null,
      }),
    ).toEqual({ ok: true, data: "2026-11-06T10:00:00Z" });
    expect(calls[0]?.steps[0]?.[1][0]).toEqual({
      p_surface: "Compass",
      p_disclosure_version: "2026-11-06",
      p_choice: "Declined",
    });
  });
});
