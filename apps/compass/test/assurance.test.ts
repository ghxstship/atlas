import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { redeemRecoveryCode, secondFactorGate, verifySecondFactor } from "../src/runtime/assurance";

/** A stand-in client: the assurance levels, the stored session's factors and the org status row. */
function client(input: {
  current: "aal1" | "aal2";
  next: "aal1" | "aal2";
  factors?: { id: string; factor_type: string; status: string; friendly_name?: string }[];
  org?: Record<string, unknown> | null;
}) {
  const rpc = vi.fn(async () => ({ data: input.org ? [input.org] : [], error: null }));
  const challengeAndVerify = vi.fn();
  const fake = {
    auth: {
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentLevel: input.current, nextLevel: input.next },
          error: null,
        }),
        challengeAndVerify,
      },
      getSession: async () => ({
        data: { session: { user: { factors: input.factors ?? [] } } },
        error: null,
      }),
    },
    rpc,
  };
  return { db: fake as unknown as SupabaseClient, rpc, challengeAndVerify };
}

const PHONE = { id: "f1", factor_type: "totp", status: "verified", friendly_name: "Phone" };

describe("the second factor in Compass (A77)", () => {
  it("asks a person who holds an authenticator app to verify it after signing in", async () => {
    const { db, rpc } = client({ current: "aal1", next: "aal2", factors: [PHONE] });
    expect(await secondFactorGate(db, null)).toEqual({
      kind: "verify",
      factors: [{ id: "f1", label: "Phone" }],
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("lets a verified session through and asks nothing of a person without factors", async () => {
    expect(
      await secondFactorGate(client({ current: "aal2", next: "aal2", factors: [PHONE] }).db, null),
    ).toEqual({ kind: "ok" });
    expect(await secondFactorGate(client({ current: "aal1", next: "aal1" }).db, null)).toEqual({
      kind: "ok",
    });
  });

  // security.mfa_policy asks a factor; security.session_hours has ended the session.
  it("follows the org: a required factor to verify or set up elsewhere, an ended session to sign in again", async () => {
    const none = client({
      current: "aal1",
      next: "aal1",
      org: { mfa_required: true, mfa_verified: false },
    });
    expect(await secondFactorGate(none.db, "org-1")).toEqual({ kind: "enroll-elsewhere" });
    expect(none.rpc).toHaveBeenCalledWith("my_org_auth_status", { p_org_id: "org-1" });
    const met = client({
      current: "aal2",
      next: "aal2",
      factors: [PHONE],
      org: { mfa_required: true, mfa_verified: true },
    });
    expect(await secondFactorGate(met.db, "org-1")).toEqual({ kind: "ok" });
    const ended = client({ current: "aal2", next: "aal2", org: { session_expired: true } });
    expect(await secondFactorGate(ended.db, "org-1")).toEqual({ kind: "sign-in-again" });
  });

  it("verifies a code with its spaces removed and tells a wrong code from a lost network", async () => {
    const { db, challengeAndVerify } = client({ current: "aal1", next: "aal2" });
    challengeAndVerify
      .mockResolvedValueOnce({ data: {}, error: null })
      .mockResolvedValueOnce({ data: null, error: { status: 422, message: "Invalid TOTP code" } })
      .mockResolvedValueOnce({ data: null, error: { status: 0, message: "Failed to fetch" } });
    expect(await verifySecondFactor(db, "f1", "123 456")).toBe("ok");
    expect(challengeAndVerify).toHaveBeenCalledWith({ factorId: "f1", code: "123456" });
    expect(await verifySecondFactor(db, "f1", "000000")).toBe("invalid");
    expect(await verifySecondFactor(db, "f1", "000000")).toBe("network");
  });
});

describe("recovery codes and signed-out sessions in Compass (A99)", () => {
  it("signs in again once the session was signed out from another device", async () => {
    const ended = client({ current: "aal2", next: "aal2", org: { session_ended: true } });
    expect(await secondFactorGate(ended.db, "org-1")).toEqual({ kind: "sign-in-again" });
  });

  it("spends a recovery code, refreshes the session, and names a wrong code, a lockout and a lost network", async () => {
    const refreshSession = vi.fn(async () => ({ data: { session: {} }, error: null }));
    const answers = [
      { data: [{ outcome: "ok", remaining: 9 }], error: null },
      { data: [{ outcome: "code_invalid", remaining: null }], error: null },
      { data: [{ outcome: "rate_limited", remaining: null }], error: null },
      { data: null, error: { code: "", message: "Failed to fetch" } },
    ];
    const rpc = vi.fn(async () => answers.shift());
    const db = { rpc, auth: { refreshSession } } as unknown as SupabaseClient;
    expect(await redeemRecoveryCode(db, " abcde-fghjk ")).toBe("ok");
    expect(rpc).toHaveBeenCalledWith("redeem_recovery_code", { p_code: "abcde-fghjk" });
    expect(refreshSession).toHaveBeenCalledOnce();
    expect(await redeemRecoveryCode(db, "abcde-fghjk")).toBe("invalid");
    expect(await redeemRecoveryCode(db, "abcde-fghjk")).toBe("locked");
    expect(await redeemRecoveryCode(db, "abcde-fghjk")).toBe("network");
    expect(refreshSession).toHaveBeenCalledOnce();
  });
});
