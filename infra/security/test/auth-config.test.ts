import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Regression gate for A22-010 (ASVS V6.2.1, V6.2.3, V6.3.3; Section 9): the committed Supabase Auth
 * settings in supabase/config.toml never fall below the reviewed values. The breached-password check
 * is a hosted dashboard setting and is covered by the deployment runbook, not by this file.
 */
const CONFIG = new URL("../../../supabase/config.toml", import.meta.url);

/** The `key = value` lines of each `[section]`, without comments. Enough TOML for these checks. */
function sections(text: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  let current = "";
  out.set(current, new Map());
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header !== null) {
      current = header[1] ?? "";
      if (!out.has(current)) out.set(current, new Map());
      continue;
    }
    const pair = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (pair !== null) out.get(current)?.set(pair[1] ?? "", (pair[2] ?? "").trim());
  }
  return out;
}

const config = sections(readFileSync(CONFIG, "utf8"));
const value = (section: string, key: string) => config.get(section)?.get(key);

describe("Supabase Auth settings (A22-010)", () => {
  it("require passwords of at least 12 characters with letters and digits", () => {
    expect(Number(value("auth", "minimum_password_length"))).toBeGreaterThanOrEqual(12);
    expect([
      '"letters_digits"',
      '"lower_upper_letters_digits"',
      '"lower_upper_letters_digits_symbols"',
    ]).toContain(value("auth", "password_requirements"));
  });

  it("require the current session to be recent to change a password", () => {
    expect(value("auth.email", "secure_password_change")).toBe("true");
  });

  it("offer TOTP and WebAuthn multi-factor authentication and passkeys", () => {
    expect(value("auth.mfa.totp", "enroll_enabled")).toBe("true");
    expect(value("auth.mfa.totp", "verify_enabled")).toBe("true");
    expect(value("auth.mfa.web_authn", "enroll_enabled")).toBe("true");
    expect(value("auth.mfa.web_authn", "verify_enabled")).toBe("true");
    expect(value("auth.passkey", "enabled")).toBe("true");
    expect(value("auth.webauthn", "rp_id")).toBeDefined();
  });

  it("keep refresh token rotation on and anonymous sign-ins off", () => {
    expect(value("auth", "enable_refresh_token_rotation")).toBe("true");
    expect(value("auth", "enable_anonymous_sign_ins")).toBe("false");
  });
});

describe("Sign in with Google (ADR 0036)", () => {
  const google = (key: string) => value("auth.external.google", key);

  it("reads the client ID and secret from the environment, never from the file", () => {
    expect(google("client_id")).toBe('"env(SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID)"');
    expect(google("secret")).toBe('"env(SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET)"');
  });

  it("returns from Google to this stack's Auth callback", () => {
    expect(google("enabled")).toBe("true");
    expect(google("redirect_uri")).toMatch(/^"http:\/\/127\.0\.0\.1:\d+\/auth\/v1\/callback"$/);
    expect(google("redirect_uri")).toContain(`:${value("api", "port")}/`);
    expect(google("email_optional")).toBe("false");
  });

  it("links a Google identity only through automatic linking of verified emails", () => {
    // Manual linking would let a signed-in session attach any Google account to itself.
    expect(value("auth", "enable_manual_linking")).toBe("false");
    expect(value("auth", "enable_signup")).toBe("true");
  });

  it("keeps the custom access token hook, so Google sessions carry the active org claim", () => {
    expect(value("auth.hook.custom_access_token", "enabled")).toBe("true");
    expect(value("auth.hook.custom_access_token", "uri")).toBe(
      '"pg-functions://postgres/private/custom_access_token_hook"',
    );
  });
});
