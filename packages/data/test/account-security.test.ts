import { describe, expect, it, vi } from "vitest";
import {
  accountSecurityError,
  deviceName,
  generateRecoveryCodes,
  getRecoveryCodeStatus,
  listMySessions,
  listSecurityEvents,
  looksLikeRecoveryCode,
  pruneRecoveryCodes,
  redeemRecoveryCode,
  signOutOtherSessions,
  signOutSession,
  touchMySession,
} from "../src/account-security.ts";
import type { XosClient } from "../src/client.ts";

/** A stand-in for the parts of the Supabase client these functions call. */
function client(rpcs: Record<string, unknown>, auth: Record<string, unknown> = {}) {
  const rpc = vi.fn(async (name: string) => rpcs[name] ?? { data: [], error: null });
  return { db: { rpc, auth } as unknown as XosClient, rpc };
}
const refusal = (rule: string) => ({
  data: null,
  error: { code: "XR001", message: `${rule}: Refused.`, hint: rule },
});

describe("recovery codes", () => {
  it("reads the status, with an empty set before any were made", async () => {
    const { db } = client({
      my_recovery_code_status: {
        data: [
          {
            total: 10,
            remaining: 7,
            created_at: "2026-10-21T10:00:00Z",
            last_used_at: null,
            usable: true,
          },
        ],
        error: null,
      },
    });
    expect(await getRecoveryCodeStatus(db)).toEqual({
      ok: true,
      data: {
        total: 10,
        remaining: 7,
        createdAt: "2026-10-21T10:00:00Z",
        lastUsedAt: null,
        usable: true,
      },
    });
    expect(await getRecoveryCodeStatus(client({}).db)).toMatchObject({
      ok: true,
      data: { total: 0, remaining: 0, usable: false },
    });
  });

  it("returns the new codes once and keeps the step-up refusal", async () => {
    const { db } = client({
      generate_recovery_codes: {
        data: [{ code: "abcde-fghjk" }, { code: "mnpqr-stvwx" }],
        error: null,
      },
    });
    expect(await generateRecoveryCodes(db)).toEqual({
      ok: true,
      data: ["abcde-fghjk", "mnpqr-stvwx"],
    });
    const refused = await generateRecoveryCodes(
      client({ generate_recovery_codes: refusal("step_up_required") }).db,
    );
    expect(refused).toMatchObject({
      ok: false,
      error: { kind: "refusal", rule: "step_up_required" },
    });
  });

  it("checks what a typed code looks like", () => {
    expect(looksLikeRecoveryCode("abcde-fghjk")).toBe(true);
    expect(looksLikeRecoveryCode(" ABCDE FGHJK ")).toBe(true);
    expect(looksLikeRecoveryCode("123456")).toBe(false);
  });

  it("spends a code, then refreshes the session for its aal2 token", async () => {
    const refreshSession = vi.fn(async () => ({
      data: { session: { access_token: "t" } },
      error: null,
    }));
    const { db, rpc } = client(
      { redeem_recovery_code: { data: [{ outcome: "ok", remaining: 9 }], error: null } },
      { refreshSession },
    );
    expect(await redeemRecoveryCode(db, "abcde-fghjk")).toEqual({
      ok: true,
      data: { remaining: 9 },
    });
    expect(rpc).toHaveBeenCalledWith("redeem_recovery_code", { p_code: "abcde-fghjk" });
    expect(refreshSession).toHaveBeenCalledOnce();
  });

  it("names a refused code without refreshing anything", async () => {
    const refreshSession = vi.fn();
    for (const outcome of ["code_invalid", "rate_limited", "no_codes"]) {
      const { db } = client(
        { redeem_recovery_code: { data: [{ outcome, remaining: null }], error: null } },
        { refreshSession },
      );
      expect(await redeemRecoveryCode(db, "x")).toMatchObject({
        ok: false,
        error: { rule: outcome },
      });
    }
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it("reports a refresh that fails after the code was spent", async () => {
    const { db } = client(
      { redeem_recovery_code: { data: [{ outcome: "ok", remaining: 3 }], error: null } },
      { refreshSession: async () => ({ data: { session: null }, error: { message: "network" } }) },
    );
    expect(await redeemRecoveryCode(db, "abcde-fghjk")).toMatchObject({
      ok: false,
      error: { kind: "unexpected", message: "network" },
    });
  });

  it("prunes codes once no factor is left", async () => {
    expect(
      await pruneRecoveryCodes(client({ prune_recovery_codes: { data: true, error: null } }).db),
    ).toEqual({
      ok: true,
      data: true,
    });
  });
});

describe("sessions and devices", () => {
  it("maps the caller's sessions", async () => {
    const { db } = client({
      my_sessions: {
        data: [
          {
            session_id: "s1",
            is_current: true,
            signed_in_at: "2026-10-21T08:00:00Z",
            last_active_at: "2026-10-21T10:00:00Z",
            second_factor: true,
            surface: "Atlas",
            client_address: "198.51.100.7",
            place: "Lisbon, PT",
            user_agent: "Mozilla/5.0 (Macintosh) Chrome/141.0",
          },
        ],
        error: null,
      },
    });
    expect(await listMySessions(db)).toEqual({
      ok: true,
      data: [
        {
          id: "s1",
          current: true,
          signedInAt: "2026-10-21T08:00:00Z",
          lastActiveAt: "2026-10-21T10:00:00Z",
          secondFactor: true,
          surface: "Atlas",
          clientAddress: "198.51.100.7",
          place: "Lisbon, PT",
          userAgent: "Mozilla/5.0 (Macintosh) Chrome/141.0",
        },
      ],
    });
  });

  it("records the device with empty text for what is unknown", async () => {
    const { db, rpc } = client({});
    await touchMySession(db, {
      surface: "Gateway",
      clientAddress: null,
      place: null,
      userAgent: "UA",
    });
    expect(rpc).toHaveBeenCalledWith("touch_my_session", {
      p_surface: "Gateway",
      p_client_address: "",
      p_place: "",
      p_user_agent: "UA",
    });
  });

  it("signs out one session or every other one", async () => {
    const { db, rpc } = client({ sign_out_my_other_sessions: { data: 2, error: null } });
    expect(await signOutSession(db, "s2")).toEqual({ ok: true, data: null });
    expect(rpc).toHaveBeenCalledWith("sign_out_my_session", { p_session_id: "s2" });
    expect(await signOutOtherSessions(db)).toEqual({ ok: true, data: 2 });
    const current = await signOutSession(
      client({ sign_out_my_session: refusal("session_current") }).db,
      "s1",
    );
    expect(current).toMatchObject({ ok: false, error: { rule: "session_current" } });
  });

  it("reads the trail", async () => {
    const { db } = client({
      my_security_events: {
        data: [
          {
            kind: "recovery_code_used",
            occurred_at: "t",
            detail: { remaining: 9 },
            this_session: true,
          },
          { kind: "session_signed_out", occurred_at: "t", detail: null, this_session: false },
        ],
        error: null,
      },
    });
    const result = await listSecurityEvents(db, 5);
    expect(result).toMatchObject({
      ok: true,
      data: [
        { kind: "recovery_code_used", detail: { remaining: 9 }, thisSession: true },
        { kind: "session_signed_out", detail: {}, thisSession: false },
      ],
    });
  });
});

describe("device names", () => {
  it.each([
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15",
      "safari",
      "macos",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0 Safari/537.36 Edg/141.0",
      "edge",
      "windows",
    ],
    ["Mozilla/5.0 (Windows NT 10.0) Chrome/141.0 Safari/537.36", "chrome", "windows"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0", "firefox", "linux"],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) CriOS/141.0 Mobile Safari/604.1",
      "chrome",
      "ios",
    ],
    [
      "Mozilla/5.0 (Linux; Android 16) Chrome/141.0 Mobile Safari/537.36 OPR/90.0",
      "opera",
      "android",
    ],
    ["Compass/1.0 (iPhone; iOS 26)", "compass", "ios"],
    ["Mozilla/5.0 (X11; CrOS x86_64 16000.0.0) Chrome/141.0", "chrome", "chromeos"],
  ])("reads %s", (ua, browser, os) => {
    expect(deviceName(ua)).toEqual({ browser, os });
  });

  it("calls anything else other", () => {
    expect(deviceName(null)).toEqual({ browser: "other", os: "other" });
  });
});

describe("error keys", () => {
  it("keeps known rules and hides the rest", () => {
    expect(accountSecurityError({ kind: "refusal", rule: "code_invalid", message: "" })).toBe(
      "code_invalid",
    );
    expect(accountSecurityError({ kind: "refusal", rule: "other", message: "" })).toBe(
      "unexpected",
    );
    expect(accountSecurityError({ kind: "not-found" })).toBe("denied");
    expect(accountSecurityError({ kind: "unexpected", message: "x" })).toBe("unexpected");
  });
});
