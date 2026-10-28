import type { SupabaseClient } from "@supabase/supabase-js";
import { deviceName } from "@xos/data/account-security";
import { getMessages } from "@xos/i18n";
import { describe, expect, it, vi } from "vitest";
import {
  changePassword,
  compassUserAgent,
  isStepUpRefusal,
  needsStepUp,
  passwordOutcome,
  recoveryCodesText,
  securityErrorKey,
  sendPasswordCode,
  STEP_UP,
} from "../src/settings/security";

/**
 * Settings, Security in Compass (A110, ADR 0070): step-up by Gateway's rule, a password change through Supabase
 * Auth with the emailed code a day-old session needs, and the session Compass records for this device.
 */

function message(key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      getMessages("es-US"),
    );
}

describe("step-up", () => {
  it("asks for a recent second factor before removing a factor or making recovery codes", () => {
    expect(STEP_UP["removeFactor"]).toBe("always");
    expect(STEP_UP["makeRecoveryCodes"]).toBe("always");
    expect(needsStepUp("always", true, false)).toBe(true);
    expect(needsStepUp("always", false, false)).toBe(true);
  });

  it("asks before a password change or removing a passkey only of a person who holds a factor", () => {
    expect(STEP_UP["changePassword"]).toBe("if-factor");
    expect(STEP_UP["removePasskey"]).toBe("if-factor");
    expect(needsStepUp("if-factor", false, false)).toBe(false);
    expect(needsStepUp("if-factor", true, false)).toBe(true);
  });

  it("asks nothing of a session that passed a second factor in the last 15 minutes", () => {
    expect(needsStepUp("always", true, true)).toBe(false);
    expect(needsStepUp("if-factor", true, true)).toBe(false);
  });

  it("knows a step-up refusal from any other", () => {
    expect(isStepUpRefusal({ kind: "refusal", rule: "step_up_required", message: "" })).toBe(true);
    expect(isStepUpRefusal({ kind: "refusal", rule: "code_invalid", message: "" })).toBe(false);
    expect(isStepUpRefusal({ kind: "not-found" })).toBe(false);
  });
});

describe("security errors", () => {
  it("names each refusal the screens know, in Spanish too, and anything else as unexpected", () => {
    const keys = [
      securityErrorKey({ kind: "refusal", rule: "code_invalid", message: "" }),
      securityErrorKey({ kind: "refusal", rule: "session_current", message: "" }),
      securityErrorKey({ kind: "refusal", rule: "factor_name_taken", message: "" }),
      securityErrorKey({ kind: "refusal", rule: "something_new", message: "" }),
      securityErrorKey({ kind: "not-found" }),
      securityErrorKey({ kind: "unexpected", message: "boom" }),
    ];
    expect(keys).toEqual([
      "authSecurity.errors.code_invalid",
      "authSecurity.errors.session_current",
      "authSecurity.errors.factor_name_taken",
      "authSecurity.errors.unexpected",
      "authSecurity.errors.denied",
      "authSecurity.errors.unexpected",
    ]);
    for (const key of keys) expect(typeof message(key), key).toBe("string");
  });
});

describe("password", () => {
  it("reads Supabase Auth's answer as what the form says", () => {
    expect(passwordOutcome(null)).toBe("ok");
    expect(passwordOutcome({ code: "reauthentication_needed", message: "" })).toBe(
      "reauthenticate",
    );
    expect(passwordOutcome({ code: "reauthentication_not_valid", message: "" })).toBe(
      "code_invalid",
    );
    expect(passwordOutcome({ code: "same_password", message: "" })).toBe("same_password");
    expect(passwordOutcome({ code: "weak_password", message: "" })).toBe("weak_password");
    expect(passwordOutcome({ code: "insufficient_aal", message: "" })).toBe("step_up_required");
    expect(passwordOutcome({ code: "over_email_send_rate_limit", message: "" })).toBe(
      "rate_limited",
    );
    expect(passwordOutcome({ status: 0, message: "Network request failed" })).toBe("network");
    expect(passwordOutcome({ code: "unexpected_failure", status: 500, message: "x" })).toBe(
      "unexpected",
    );
  });

  it("sets the password, with the emailed code when the session is more than a day old", async () => {
    const updateUser = vi
      .fn()
      .mockResolvedValueOnce({
        data: null,
        error: { code: "reauthentication_needed", message: "" },
      })
      .mockResolvedValueOnce({ data: {}, error: null });
    const reauthenticate = vi.fn().mockResolvedValue({ data: {}, error: null });
    const client = { auth: { updateUser, reauthenticate } } as unknown as SupabaseClient;
    expect(await changePassword(client, "river4tangerine")).toBe("reauthenticate");
    expect(await sendPasswordCode(client)).toBe("ok");
    expect(await changePassword(client, "river4tangerine", "123456")).toBe("ok");
    expect(updateUser.mock.calls).toEqual([
      [{ password: "river4tangerine" }],
      [{ password: "river4tangerine", nonce: "123456" }],
    ]);
    expect(reauthenticate).toHaveBeenCalledTimes(1);
  });

  it("reads a thrown network failure as offline", async () => {
    const client = {
      auth: { updateUser: () => Promise.reject(new Error("fetch failed")) },
    } as unknown as SupabaseClient;
    expect(await changePassword(client, "river4tangerine")).toBe("network");
  });
});

describe("this device's session", () => {
  it("records a user agent that Sessions and devices reads as Compass on the phone's system", () => {
    expect(compassUserAgent("4.0.1", "ios", "26.5")).toBe("Compass/4.0.1 (iOS 26.5)");
    expect(deviceName(compassUserAgent("4.0.1", "ios", "26.5"))).toEqual({
      browser: "compass",
      os: "ios",
    });
    expect(deviceName(compassUserAgent("", "android", 34))).toEqual({
      browser: "compass",
      os: "android",
    });
  });
});

describe("recovery codes", () => {
  it("shares the codes as one block: heading, a code per line, and the note", () => {
    expect(
      recoveryCodesText(["abcde-23456", "fghij-78923"], "XOS recovery codes", "Each works once."),
    ).toBe("XOS recovery codes\n\nabcde-23456\nfghij-78923\n\nEach works once.");
  });
});
