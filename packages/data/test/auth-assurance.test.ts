import { AuthApiError } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  authFailure,
  finishPasskeyRegistration,
  getAssurance,
  getOrgAuthStatus,
  getStepUpStatus,
  listSecondFactors,
  needsSecondFactor,
  orgAuthDecision,
  removeSecondFactor,
  renameSecondFactor,
  startSecurityKeyEnrollment,
  startSsoSignIn,
  startTotpEnrollment,
  tokenAal,
  verifySecurityKey,
  verifyTotp,
  type OrgAuthStatus,
} from "../src/auth-assurance.ts";
import type { XosClient } from "../src/client.ts";

const authError = (code: string, message = "Refused.") => new AuthApiError(message, 422, code);

/** A stand-in for the parts of the Supabase client these functions call. */
function client(parts: { auth?: Record<string, unknown>; rpc?: Record<string, unknown> }) {
  const rpc = vi.fn(async (name: string) => parts.rpc?.[name] ?? { data: [], error: null });
  return { db: { auth: parts.auth ?? {}, rpc } as unknown as XosClient, rpc };
}

describe("authFailure", () => {
  it.each([
    ["mfa_verification_failed", "code_invalid"],
    ["mfa_challenge_expired", "code_expired"],
    ["insufficient_aal", "step_up_required"],
    ["too_many_enrolled_mfa_factors", "factor_limit"],
    ["mfa_factor_name_conflict", "factor_name_taken"],
    ["sso_provider_not_found", "sso_unavailable"],
    ["over_request_rate_limit", "rate_limited"],
  ])("maps %s to the %s refusal", (code, rule) => {
    expect(authFailure(authError(code))).toMatchObject({ kind: "refusal", rule });
  });

  it("names a failed WebAuthn ceremony and keeps anything else unexpected", () => {
    expect(authFailure(new Error("webauthn verification failed"))).toMatchObject({
      rule: "passkey_failed",
    });
    expect(authFailure(authError("unexpected_failure", "Boom"))).toEqual({
      kind: "unexpected",
      message: "Boom",
      code: "unexpected_failure",
    });
  });
});

describe("assurance", () => {
  it("reads the levels and says when a second factor is still owed", async () => {
    const { db } = client({
      auth: {
        mfa: {
          getAuthenticatorAssuranceLevel: async () => ({
            data: { currentLevel: "aal1", nextLevel: "aal2" },
            error: null,
          }),
        },
      },
    });
    const result = await getAssurance(db);
    expect(result).toEqual({ ok: true, data: { current: "aal1", next: "aal2" } });
    expect(needsSecondFactor({ current: "aal1", next: "aal2" })).toBe(true);
    expect(needsSecondFactor({ current: "aal2", next: "aal2" })).toBe(false);
    expect(needsSecondFactor({ current: "aal1", next: "aal1" })).toBe(false);
  });

  it("reads the aal claim of a token without trusting anything else", () => {
    const token = (claims: object) =>
      `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
    expect(tokenAal(token({ aal: "aal2" }))).toBe("aal2");
    expect(tokenAal(token({ aal: "aal3" }))).toBe("aal1");
    expect(tokenAal("h.not-json.s")).toBe("aal1");
    expect(tokenAal(null)).toBe("aal1");
  });

  it("reads the step-up window", async () => {
    const { db } = client({
      rpc: {
        my_step_up_status: {
          data: [
            {
              stepped_up: true,
              second_factor_at: "2026-10-20T10:00:00Z",
              expires_at: "2026-10-20T10:15:00Z",
            },
          ],
          error: null,
        },
      },
    });
    expect(await getStepUpStatus(db)).toEqual({
      ok: true,
      data: {
        steppedUp: true,
        secondFactorAt: "2026-10-20T10:00:00Z",
        expiresAt: "2026-10-20T10:15:00Z",
      },
    });
  });
});

describe("org auth status and the guard's decision", () => {
  const base: OrgAuthStatus = {
    mfaRequired: false,
    mfaVerified: false,
    signedInAt: "2026-10-20T08:00:00Z",
    sessionHours: 8,
    sessionExpiresAt: "2026-10-20T16:00:00Z",
    sessionExpired: false,
    idleTimeoutMinutes: 60,
  };
  const now = Date.parse("2026-10-20T10:00:00Z");

  it("maps the RPC row, and no row means not a member", async () => {
    const { db, rpc } = client({
      rpc: {
        my_org_auth_status: {
          data: [
            {
              mfa_required: true,
              mfa_verified: false,
              signed_in_at: base.signedInAt,
              session_hours: 8,
              session_expires_at: base.sessionExpiresAt,
              session_expired: false,
              idle_timeout_minutes: 30,
            },
          ],
          error: null,
        },
      },
    });
    const result = await getOrgAuthStatus(db, "org-1");
    expect(rpc).toHaveBeenCalledWith("my_org_auth_status", { p_org_id: "org-1" });
    expect(result).toMatchObject({ ok: true, data: { mfaRequired: true, idleTimeoutMinutes: 30 } });
    const empty = client({});
    expect(await getOrgAuthStatus(empty.db, "org-1")).toEqual({ ok: true, data: null });
  });

  it("lets a fresh, verified session in", () => {
    expect(orgAuthDecision(base, { lastSeenAt: now - 60_000, now })).toBe("ok");
  });

  it("asks for a second factor when the policy wants one", () => {
    expect(orgAuthDecision({ ...base, mfaRequired: true }, { lastSeenAt: null, now })).toBe("mfa");
    expect(
      orgAuthDecision({ ...base, mfaRequired: true, mfaVerified: true }, { lastSeenAt: null, now }),
    ).toBe("ok");
  });

  it("signs in again after the org's lifetime, before asking anything else", () => {
    expect(
      orgAuthDecision(
        { ...base, sessionExpired: true, mfaRequired: true },
        { lastSeenAt: now, now },
      ),
    ).toBe("session-expired");
  });

  it("counts idle time from the later of the last request and the sign-in", () => {
    expect(orgAuthDecision(base, { lastSeenAt: now - 61 * 60_000, now })).toBe("idle");
    // Activity before this sign-in belongs to an older session.
    const fresh = { ...base, signedInAt: new Date(now - 5 * 60_000).toISOString() };
    expect(orgAuthDecision(fresh, { lastSeenAt: now - 3 * 86_400_000, now })).toBe("ok");
    expect(orgAuthDecision({ ...base, idleTimeoutMinutes: null }, { lastSeenAt: 0, now })).toBe(
      "ok",
    );
  });
});

describe("second factors", () => {
  const factors = {
    all: [
      {
        id: "f2",
        factor_type: "webauthn",
        status: "unverified",
        friendly_name: "Key",
        created_at: "2026-10-02",
      },
      {
        id: "f1",
        factor_type: "totp",
        status: "verified",
        friendly_name: "Phone",
        created_at: "2026-10-01",
      },
    ],
  };

  it("lists verified factors first, under the names people gave them", async () => {
    const { db } = client({
      auth: { mfa: { listFactors: async () => ({ data: factors, error: null }) } },
      rpc: {
        my_auth_factor_labels: { data: [{ factor_id: "f1", label: "Work phone" }], error: null },
      },
    });
    const result = await listSecondFactors(db);
    expect(result).toEqual({
      ok: true,
      data: [
        { id: "f1", type: "totp", label: "Work phone", verified: true, createdAt: "2026-10-01" },
        { id: "f2", type: "webauthn", label: "Key", verified: false, createdAt: "2026-10-02" },
      ],
    });
  });

  it("clears unfinished enrollments of the type before starting another", async () => {
    const unenroll = vi.fn(async () => ({ data: {}, error: null }));
    const enroll = vi.fn(async () => ({
      data: { id: "f3", totp: { qr_code: "data:image/svg+xml;utf-8,<svg/>", secret: "SECRET" } },
      error: null,
    }));
    const { db } = client({
      auth: {
        mfa: {
          listFactors: async () => ({
            data: {
              all: [
                { id: "old", factor_type: "totp", status: "unverified" },
                { id: "f1", factor_type: "totp", status: "verified" },
              ],
            },
            error: null,
          }),
          unenroll,
          enroll,
        },
      },
    });
    const result = await startTotpEnrollment(db, "  Phone  ");
    expect(unenroll).toHaveBeenCalledTimes(1);
    expect(unenroll).toHaveBeenCalledWith({ factorId: "old" });
    expect(enroll).toHaveBeenCalledWith({ factorType: "totp", friendlyName: "Phone" });
    expect(result).toEqual({
      ok: true,
      data: { factorId: "f3", qrCode: "data:image/svg+xml;utf-8,<svg/>", secret: "SECRET" },
    });
  });

  it("verifies a code with its spaces removed and names a wrong one", async () => {
    const challengeAndVerify = vi
      .fn()
      .mockResolvedValueOnce({ data: {}, error: null })
      .mockResolvedValueOnce({ data: null, error: authError("mfa_verification_failed") });
    const { db } = client({ auth: { mfa: { challengeAndVerify } } });
    expect(await verifyTotp(db, "f1", "123 456")).toEqual({ ok: true, data: null });
    expect(challengeAndVerify).toHaveBeenCalledWith({ factorId: "f1", code: "123456" });
    expect(await verifyTotp(db, "f1", "000000")).toMatchObject({
      ok: false,
      error: { rule: "code_invalid" },
    });
  });

  it("asks for step-up when Supabase Auth refuses to remove a verified factor", async () => {
    const { db } = client({
      auth: {
        mfa: { unenroll: async () => ({ data: null, error: authError("insufficient_aal") }) },
      },
    });
    expect(await removeSecondFactor(db, "f1")).toMatchObject({
      ok: false,
      error: { kind: "refusal", rule: "step_up_required" },
    });
  });

  it("renames through the label RPC", async () => {
    const { db, rpc } = client({ rpc: { set_auth_factor_label: { data: null, error: null } } });
    expect(await renameSecondFactor(db, "f1", "Old phone")).toEqual({ ok: true, data: null });
    expect(rpc).toHaveBeenCalledWith("set_auth_factor_label", {
      p_factor_id: "f1",
      p_label: "Old phone",
    });
  });

  it("enrolls a security key with the relying party from configuration and returns JSON options", async () => {
    const challenge = vi.fn(async () => ({
      data: {
        id: "ch1",
        type: "webauthn",
        webauthn: {
          type: "create",
          credential_options: {
            publicKey: {
              challenge: new Uint8Array([1, 2, 3]).buffer,
              user: { id: new Uint8Array([4]).buffer, name: "a", displayName: "a" },
              rp: { id: "localhost", name: "XOS" },
              pubKeyCredParams: [{ type: "public-key", alg: -7 }],
            },
          },
        },
      },
      error: null,
    }));
    const { db } = client({
      auth: {
        mfa: {
          listFactors: async () => ({ data: { all: [] }, error: null }),
          enroll: async () => ({ data: { id: "f9" }, error: null }),
          challenge,
        },
      },
    });
    const rp = { id: "localhost", origins: ["http://localhost:3000"] };
    const result = await startSecurityKeyEnrollment(db, "Key", rp);
    expect(challenge).toHaveBeenCalledWith({
      factorId: "f9",
      webauthn: { rpId: "localhost", rpOrigins: ["http://localhost:3000"] },
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        factorId: "f9",
        challengeId: "ch1",
        ceremony: { kind: "create", options: { challenge: "AQID", user: { id: "BA" } } },
      },
    });
  });

  it("passes the browser's credential JSON to verification unchanged", async () => {
    const verify = vi.fn(async () => ({ data: {}, error: null }));
    const { db } = client({ auth: { mfa: { verify } } });
    const credential = {
      id: "c",
      rawId: "c",
      type: "public-key" as const,
      response: {},
      clientExtensionResults: {},
    };
    await verifySecurityKey(db, {
      factorId: "f9",
      challengeId: "ch1",
      kind: "request",
      credential,
      rp: { id: "localhost", origins: ["http://localhost:3000"] },
    });
    const sent = (
      verify.mock.calls[0] as unknown as [
        { webauthn: { credential_response: { toJSON(): unknown } } },
      ]
    )[0];
    expect(sent.webauthn.credential_response.toJSON()).toBe(credential);
  });
});

describe("passkeys and single sign-on", () => {
  it("names a new passkey after registering it", async () => {
    const update = vi.fn(async () => ({ data: {}, error: null }));
    const { db } = client({
      auth: {
        passkey: {
          verifyRegistration: async () => ({
            data: { id: "pk1", friendly_name: "Passkey", created_at: "2026-10-20" },
            error: null,
          }),
          update,
        },
      },
    });
    const credential = {
      id: "c",
      rawId: "c",
      type: "public-key" as const,
      response: {},
      clientExtensionResults: {},
    };
    const result = await finishPasskeyRegistration(db, "ch", credential, "Laptop");
    expect(update).toHaveBeenCalledWith({ passkeyId: "pk1", friendlyName: "Laptop" });
    expect(result).toMatchObject({ ok: true, data: { id: "pk1", label: "Laptop" } });
  });

  it("starts SSO by the email's domain and refuses an address without one", async () => {
    const signInWithSSO = vi.fn(async () => ({
      data: { url: "https://idp.example/sso" },
      error: null,
    }));
    const { db } = client({ auth: { signInWithSSO } });
    expect(
      await startSsoSignIn(db, { email: "Ana@Example.COM", redirectTo: "http://localhost/cb" }),
    ).toEqual({ ok: true, data: "https://idp.example/sso" });
    expect(signInWithSSO).toHaveBeenCalledWith({
      domain: "example.com",
      options: { redirectTo: "http://localhost/cb" },
    });
    expect(await startSsoSignIn(db, { email: "nobody", redirectTo: "x" })).toMatchObject({
      ok: false,
      error: { rule: "sso_unavailable" },
    });
  });
});
