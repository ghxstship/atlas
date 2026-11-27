import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  exchangedResetLink,
  newPasswordError,
  RECOVERY_WINDOW_SECONDS,
  recoveryIsFresh,
  resetRequestOutcome,
  tokenRecoveredAt,
} from "@/lib/auth/recovery";

/**
 * Forgot password (release 4.19, lib/auth/recovery.ts): the request answers the same way whether or not an account uses
 * the address, the link only returns to this site, and only a session that opened a reset link recently may set a
 * password, after its second factor when it holds one. Supabase Auth is a stub here; the journey
 * (e2e/r419-forgot-password.spec.ts) runs the real thing against the local stack.
 */

class Redirected extends Error {
  constructor(readonly url: string) {
    super(`redirect ${url}`);
  }
}

const NOW = Date.UTC(2026, 10, 27, 15, 0, 0);
const NOW_S = NOW / 1000;

/** An unsigned access token with these claims: the code only reads claims of a session getUser() confirmed. */
function token(claims: Record<string, unknown>): string {
  const b64 = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url").replace(/=+$/, "");
  return `${b64({ alg: "HS256" })}.${b64(claims)}.signature`;
}

const recovered = (at: number, aal = "aal1") =>
  token({ aal, amr: [{ method: "recovery", timestamp: at }] });

describe("the reset link's session", () => {
  it("reads when the session opened a reset link", () => {
    expect(tokenRecoveredAt(recovered(NOW_S - 60))).toBe(NOW_S - 60);
    expect(
      tokenRecoveredAt(
        token({
          amr: [
            { method: "recovery", timestamp: NOW_S - 600 },
            { method: "totp", timestamp: NOW_S - 30 },
            { method: "recovery", timestamp: NOW_S - 120 },
          ],
        }),
      ),
    ).toBe(NOW_S - 120);
  });

  it("finds no reset in any other session or in a malformed token", () => {
    for (const value of [
      null,
      undefined,
      "",
      "not-a-token",
      "a.!!!.c",
      token({ amr: [{ method: "password", timestamp: NOW_S }] }),
      token({ amr: [{ method: "otp", timestamp: NOW_S }] }),
      token({ amr: "recovery" }),
      token({ amr: [{ method: "recovery", timestamp: "now" }] }),
      token({ amr: [null, 5, { method: "recovery" }] }),
      `${token({}).split(".")[0]}.${Buffer.from("[1,2]").toString("base64url")}.x`,
    ]) {
      expect(tokenRecoveredAt(value)).toBeNull();
    }
  });

  it("lets it set a password for half an hour, allowing a minute of clock difference", () => {
    expect(recoveryIsFresh(recovered(NOW_S), NOW)).toBe(true);
    expect(recoveryIsFresh(recovered(NOW_S - RECOVERY_WINDOW_SECONDS), NOW)).toBe(true);
    expect(recoveryIsFresh(recovered(NOW_S - RECOVERY_WINDOW_SECONDS - 1), NOW)).toBe(false);
    expect(recoveryIsFresh(recovered(NOW_S + 60), NOW)).toBe(true);
    expect(recoveryIsFresh(recovered(NOW_S + 61), NOW)).toBe(false);
    expect(recoveryIsFresh(token({ amr: [{ method: "password", timestamp: NOW_S }] }), NOW)).toBe(
      false,
    );
  });

  it("knows a code exchange that came from a reset link", () => {
    const signedIn = { access_token: token({ amr: [{ method: "otp", timestamp: NOW_S }] }) };
    expect(exchangedResetLink({ session: { access_token: recovered(NOW_S) } }, NOW)).toBe(true);
    expect(exchangedResetLink({ session: signedIn, redirectType: "recovery" } as never, NOW)).toBe(
      true,
    );
    expect(exchangedResetLink({ session: signedIn }, NOW)).toBe(false);
    expect(exchangedResetLink({ session: signedIn, redirectType: null } as never, NOW)).toBe(false);
    expect(exchangedResetLink({ session: null }, NOW)).toBe(false);
  });
});

describe("Supabase Auth's answers", () => {
  it("reads every answer about an address as sent, so none tells whether an account uses it", () => {
    expect(resetRequestOutcome(null)).toBe("sent");
    // Only an address with an account can reach the per-address interval, the hourly email limit or a mail fault.
    expect(resetRequestOutcome({ code: "over_email_send_rate_limit", status: 429 })).toBe("sent");
    expect(resetRequestOutcome({ code: "unexpected_failure", status: 500 })).toBe("sent");
    expect(resetRequestOutcome({ status: 500 })).toBe("sent");
  });

  it("names the request rate limit, which counts requests before any account is looked up", () => {
    expect(resetRequestOutcome({ code: "over_request_rate_limit", status: 429 })).toBe(
      "rate_limited",
    );
    expect(resetRequestOutcome({ status: 429 })).toBe("rate_limited");
  });

  it("turns a refused new password into the form's message", () => {
    expect(newPasswordError({ code: "weak_password" })).toBe("weak_password");
    expect(newPasswordError({ code: "same_password" })).toBe("same_password");
    expect(newPasswordError({ code: "insufficient_aal" })).toBe("second_factor");
    for (const code of [
      "reauthentication_needed",
      "session_not_found",
      "session_expired",
      "user_not_found",
      "bad_jwt",
      "no_authorization",
    ]) {
      expect(newPasswordError({ code })).toBe("reset_link_invalid");
    }
    expect(newPasswordError({ code: "over_request_rate_limit" })).toBe("over_request_rate_limit");
    expect(newPasswordError({ status: 429 })).toBe("over_request_rate_limit");
    expect(newPasswordError({ code: "unexpected_failure", status: 500 })).toBe("unexpected");
  });
});

// The server actions ------------------------------------------------------------------------------------------------

const auth = vi.hoisted(() => ({
  user: null as unknown,
  accessToken: null as string | null,
  resetError: null as unknown,
  updateError: null as unknown,
  resetPasswordForEmail: vi.fn(),
  updateUser: vi.fn(),
}));
const security = vi.hoisted(() => ({
  signOutOtherSessions: vi.fn(async () => ({ ok: true, data: 2 }) as unknown),
}));
const logs = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirected(url);
  },
}));
vi.mock("@/lib/env", () => ({ env: () => ({ GATEWAY_SITE_URL: "https://gateway.test" }) }));
vi.mock("@/lib/observability", () => ({ observability: { logger: logs } }));
vi.mock("@xos/data/account-security", () => ({
  signOutOtherSessions: security.signOutOtherSessions,
}));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: async () => ({
    auth: {
      getUser: async () => ({ data: { user: auth.user } }),
      getSession: async () => ({
        data: { session: auth.accessToken ? { access_token: auth.accessToken } : null },
      }),
      resetPasswordForEmail: async (email: string, options: unknown) => {
        auth.resetPasswordForEmail(email, options);
        return { data: {}, error: auth.resetError };
      },
      updateUser: async (attributes: unknown) => {
        auth.updateUser(attributes);
        return { data: {}, error: auth.updateError };
      },
    },
  }),
}));

const { requestPasswordReset, setNewPassword } = await import("@/app/auth/password-reset-actions");

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) data.set(name, value);
  return data;
}

async function redirectOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    if (error instanceof Redirected) return error.url;
    throw error;
  }
  throw new Error("The action did not redirect.");
}

const PERSON = {
  id: "person-1",
  email: "rae.reset@example.com",
  user_metadata: { full_name: "Rae Reset" },
  factors: [] as { status: string }[],
};
const GOOD = "Lantern harbor 2048";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  auth.user = { ...PERSON, factors: [] };
  auth.accessToken = recovered(NOW_S - 60);
  auth.resetError = null;
  auth.updateError = null;
  auth.resetPasswordForEmail.mockClear();
  auth.updateUser.mockClear();
  security.signOutOtherSessions.mockClear();
  security.signOutOtherSessions.mockResolvedValue({ ok: true, data: 2 });
  logs.warn.mockClear();
  logs.error.mockClear();
});

describe("requestPasswordReset", () => {
  it("asks Supabase Auth for the recovery email with a link back to this site's callback", async () => {
    const state = await requestPasswordReset({}, form({ email: "  rae.reset@example.com " }));
    expect(state).toEqual({ ok: true, values: { email: "rae.reset@example.com" } });
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith("rae.reset@example.com", {
      redirectTo: "https://gateway.test/auth/callback?next=%2Fauth%2Freset-password",
    });
  });

  it("never takes the link's address from the form", async () => {
    await requestPasswordReset(
      {},
      form({
        email: "rae.reset@example.com",
        next: "https://evil.example/",
        redirectTo: "https://evil.example/",
      }),
    );
    const [, options] = auth.resetPasswordForEmail.mock.calls[0] as [
      string,
      { redirectTo: string },
    ];
    expect(new URL(options.redirectTo).origin).toBe("https://gateway.test");
  });

  it("answers an address with no account exactly as one with an account", async () => {
    const withAccount = await requestPasswordReset({}, form({ email: "rae.reset@example.com" }));
    // Supabase Auth answers 200 with no email for an unknown address; its per-address limits reach only real ones.
    auth.resetError = { code: "over_email_send_rate_limit", status: 429 };
    const limited = await requestPasswordReset({}, form({ email: "rae.reset@example.com" }));
    auth.resetError = { code: "unexpected_failure", status: 500 };
    const failed = await requestPasswordReset({}, form({ email: "rae.reset@example.com" }));
    expect(limited).toEqual(withAccount);
    expect(failed).toEqual(withAccount);
    // Operators hear of it, with the code and no address.
    expect(logs.warn).toHaveBeenCalledWith("password reset email was not sent", {
      code: "unexpected_failure",
      status: 500,
    });
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain("rae.reset");
  });

  it("says when the request rate limit refused it", async () => {
    auth.resetError = { code: "over_request_rate_limit", status: 429 };
    expect(await requestPasswordReset({}, form({ email: "rae.reset@example.com" }))).toEqual({
      error: "over_request_rate_limit",
      values: { email: "rae.reset@example.com" },
    });
  });

  it("refuses a malformed address before asking anyone", async () => {
    for (const email of ["", "rae", "rae@", "a".repeat(330) + "@example.com"]) {
      expect(await requestPasswordReset({}, form({ email }))).toEqual({
        fieldErrors: { email: "email" },
        values: { email },
      });
    }
    expect(auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });
});

describe("setNewPassword", () => {
  it("saves the password, ends the other sessions and shows the done page", async () => {
    const to = await redirectOf(setNewPassword({}, form({ password: GOOD, confirm: GOOD })));
    expect(to).toBe("/auth/reset-password?done=1");
    expect(auth.updateUser).toHaveBeenCalledWith({ password: GOOD });
    expect(security.signOutOtherSessions).toHaveBeenCalledTimes(1);
  });

  it("logs, and still finishes, when the other sessions could not be ended", async () => {
    security.signOutOtherSessions.mockResolvedValueOnce({ ok: false, error: { code: "x" } });
    const to = await redirectOf(setNewPassword({}, form({ password: GOOD, confirm: GOOD })));
    expect(to).toBe("/auth/reset-password?done=1");
    expect(logs.error).toHaveBeenCalledWith(
      "other sessions were not ended after a password reset",
      { error: { code: "x" } },
    );
  });

  it("refuses a session that did not come from a reset link, or came too long ago", async () => {
    for (const accessToken of [
      token({ aal: "aal1", amr: [{ method: "password", timestamp: NOW_S - 60 }] }),
      recovered(NOW_S - RECOVERY_WINDOW_SECONDS - 5),
      null,
    ]) {
      auth.accessToken = accessToken;
      expect(await setNewPassword({}, form({ password: GOOD, confirm: GOOD }))).toEqual({
        error: "reset_link_invalid",
      });
    }
    auth.user = null;
    expect(await setNewPassword({}, form({ password: GOOD, confirm: GOOD }))).toEqual({
      error: "reset_link_invalid",
    });
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it("sends a person who holds a second factor to verify it first", async () => {
    auth.user = { ...PERSON, factors: [{ status: "verified" }] };
    const to = await redirectOf(setNewPassword({}, form({ password: GOOD, confirm: GOOD })));
    expect(to).toBe("/auth/mfa?next=%2Fauth%2Freset-password");
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it("saves it once the second factor passed", async () => {
    auth.user = { ...PERSON, factors: [{ status: "verified" }] };
    auth.accessToken = token({
      aal: "aal2",
      amr: [
        { method: "totp", timestamp: NOW_S - 10 },
        { method: "recovery", timestamp: NOW_S - 90 },
      ],
    });
    const to = await redirectOf(setNewPassword({}, form({ password: GOOD, confirm: GOOD })));
    expect(to).toBe("/auth/reset-password?done=1");
  });

  it("sends the person to the second factor when Supabase Auth asks for it", async () => {
    auth.updateError = { code: "insufficient_aal", status: 403 };
    const to = await redirectOf(setNewPassword({}, form({ password: GOOD, confirm: GOOD })));
    expect(to).toBe("/auth/mfa?next=%2Fauth%2Freset-password");
    expect(security.signOutOtherSessions).not.toHaveBeenCalled();
  });

  it("applies the sign-up password rules", async () => {
    for (const password of ["short1", "no digits at all here", "123456789012345"]) {
      expect(await setNewPassword({}, form({ password, confirm: password }))).toEqual({
        fieldErrors: { password: "password" },
      });
    }
    for (const password of ["rae.reset 2048 x", "Reset harbor 2048", "gateway harbor 2048"]) {
      expect(await setNewPassword({}, form({ password, confirm: password }))).toEqual({
        fieldErrors: { password: "passwordContext" },
      });
    }
    expect(await setNewPassword({}, form({ password: GOOD, confirm: `${GOOD}!` }))).toEqual({
      fieldErrors: { confirm: "passwordConfirm" },
    });
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it("shows Supabase Auth's refusals on the right field", async () => {
    auth.updateError = { code: "weak_password", status: 422 };
    expect(await setNewPassword({}, form({ password: GOOD, confirm: GOOD }))).toEqual({
      fieldErrors: { password: "weak_password" },
    });
    auth.updateError = { code: "same_password", status: 422 };
    expect(await setNewPassword({}, form({ password: GOOD, confirm: GOOD }))).toEqual({
      fieldErrors: { password: "same_password" },
    });
    auth.updateError = { code: "session_not_found", status: 403 };
    expect(await setNewPassword({}, form({ password: GOOD, confirm: GOOD }))).toEqual({
      error: "reset_link_invalid",
    });
    auth.updateError = { code: "unexpected_failure", status: 500 };
    expect(await setNewPassword({}, form({ password: GOOD, confirm: GOOD }))).toEqual({
      error: "unexpected",
    });
    expect(logs.error).toHaveBeenCalledWith("new password was not saved", {
      code: "unexpected_failure",
      status: 500,
    });
    expect(security.signOutOtherSessions).not.toHaveBeenCalled();
  });
});
