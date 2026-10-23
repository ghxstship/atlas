import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { errorKey, expiryFrom, failed, field, fromResult, IDLE } from "../lib/action-state";
import { secondFactorErrorKey, shownError, signInErrorKey } from "../lib/auth/errors";
import { safeNext } from "../lib/auth/redirect";
import { EnvError, parseEnv, passwordSignIn, secureSite } from "../lib/env";
import { negotiateLocale, parseAcceptLanguage } from "../i18n/negotiate";
import { CLIENT_NAMESPACES } from "../i18n/request";
import { authCookieName, authCookieOptions } from "../lib/supabase/cookies";
import { buildCsp, isCrossSiteMutation, securityHeaders } from "../lib/security/headers";

const appRoot = fileURLToPath(new URL("../", import.meta.url));

describe("environment", () => {
  const base = {
    SUPABASE_URL: "http://127.0.0.1:62421",
    SUPABASE_ANON_KEY: "a".repeat(40),
    CONSOLE_SITE_URL: "http://127.0.0.1:3390",
  };

  it("parses the console environment and never asks for the service role", () => {
    const config = parseEnv(base);
    expect(config.CONSOLE_SITE_URL).toBe("http://127.0.0.1:3390");
    expect(Object.keys(config)).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(secureSite(config)).toBe(false);
    expect(secureSite({ CONSOLE_SITE_URL: "https://console.ghxstship.tech" })).toBe(true);
  });

  it("names every invalid variable at once", () => {
    expect(() => parseEnv({ SUPABASE_URL: "nope" })).toThrow(EnvError);
    expect(() => parseEnv({ SUPABASE_URL: "nope" })).toThrow(
      /SUPABASE_ANON_KEY[\s\S]*CONSOLE_SITE_URL/,
    );
  });

  it("offers the password form unless production turns it off", () => {
    expect(passwordSignIn({})).toBe(true);
    expect(passwordSignIn({ CONSOLE_PASSWORD_SIGN_IN: "true" })).toBe(true);
    expect(passwordSignIn({ CONSOLE_PASSWORD_SIGN_IN: " FALSE " })).toBe(false);
  });
});

describe("session cookie and security headers", () => {
  it("keeps its own host-only session, apart from Atlas and Gateway", () => {
    expect(authCookieName(true)).toBe("__Host-xos-console-auth");
    expect(authCookieName(false)).toBe("xos-console-auth");
    expect(authCookieOptions(true)).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    });
  });

  it("sends a strict nonce policy, no framing and HSTS over https", () => {
    const csp = buildCsp({
      nonce: "abc",
      development: false,
      supabaseOrigin: "https://x.supabase.co",
      secureSite: true,
    });
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(securityHeaders(true)["Strict-Transport-Security"]).toContain("max-age");
    expect(securityHeaders(false)["Strict-Transport-Security"]).toBeUndefined();
  });

  it("refuses cross-site state changes", () => {
    const site = "https://console.ghxstship.tech";
    expect(
      isCrossSiteMutation({
        method: "POST",
        origin: "https://evil.test",
        host: "console.ghxstship.tech",
        siteOrigin: site,
      }),
    ).toBe(true);
    expect(
      isCrossSiteMutation({
        method: "POST",
        origin: null,
        host: "console.ghxstship.tech",
        siteOrigin: site,
      }),
    ).toBe(true);
    expect(
      isCrossSiteMutation({
        method: "POST",
        origin: site,
        host: "console.ghxstship.tech",
        siteOrigin: site,
      }),
    ).toBe(false);
    expect(
      isCrossSiteMutation({
        method: "GET",
        origin: "https://evil.test",
        host: "x",
        siteOrigin: site,
      }),
    ).toBe(false);
  });

  it("keeps sign-in redirects on this site", () => {
    expect(safeNext("/tenants/1", "/tenants")).toBe("/tenants/1");
    expect(safeNext("//evil.test", "/tenants")).toBe("/tenants");
    expect(safeNext("https://evil.test", "/tenants")).toBe("/tenants");
  });
});

describe("sign-in and second factor errors", () => {
  it("maps Supabase Auth codes to the console's sentences", () => {
    expect(signInErrorKey({ code: "invalid_credentials" })).toBe("invalid_credentials");
    expect(signInErrorKey({ code: "bad_oauth_state" })).toBe("link_invalid");
    expect(signInErrorKey({ status: 429 })).toBe("over_request_rate_limit");
    expect(signInErrorKey({ code: "something_new" })).toBe("unexpected");
    expect(shownError("not_operator")).toBe("not_operator");
    expect(shownError("<script>")).toBeNull();
    expect(secondFactorErrorKey({ kind: "refusal", rule: "code_invalid" })).toBe("code_invalid");
    expect(secondFactorErrorKey({ kind: "refusal", rule: "factor_limit" })).toBe("unexpected");
    expect(secondFactorErrorKey({ kind: "unexpected" })).toBe("unexpected");
  });
});

describe("console action states", () => {
  it("names refusals by rule and the second factor as the database does", () => {
    expect(errorKey({ kind: "refusal", rule: "plan_override_expiry", message: "x" })).toBe(
      "refusals.plan_override_expiry",
    );
    expect(errorKey({ kind: "refusal", rule: "step_up_required", message: "x" })).toBe(
      "errors.step_up_required",
    );
    expect(errorKey({ kind: "not-found" })).toBe("errors.notFound");
    expect(errorKey({ kind: "conflict", message: "x" })).toBe("errors.conflict");
    expect(errorKey({ kind: "invalid", message: "x" })).toBe("errors.invalid");
    expect(errorKey({ kind: "unexpected", message: "x" })).toBe("errors.unexpected");
    expect(fromResult({ ok: true, data: 1 }).status).toBe("done");
    expect(failed("errors.invalid")).toMatchObject({ status: "error", key: "errors.invalid" });
    expect(IDLE.status).toBe("idle");
  });

  it("reads fields and turns an expiry choice into an instant", () => {
    const form = new FormData();
    form.set("reason", "  Pilot.  ");
    expect(field(form, "reason")).toBe("Pilot.");
    expect(field(form, "missing")).toBe("");
    const now = new Date("2026-10-21T12:00:00Z");
    expect(expiryFrom("30", now)).toBe("2026-11-20T12:00:00.000Z");
    expect(expiryFrom("400", now)).toBeNull();
    expect(expiryFrom("x", now)).toBeNull();
  });
});

describe("locale", () => {
  it("negotiates en-US and es-US from the cookie or the browser", () => {
    expect(negotiateLocale({ cookie: "es-US" })).toBe("es-US");
    expect(negotiateLocale({ acceptLanguage: "es-MX,es;q=0.9,en;q=0.5" })).toBe("es-US");
    expect(negotiateLocale({ cookie: "en-XA", acceptLanguage: "fr" })).toBe("en-US");
    // Beta locales come from the person's choice only (ADR 0053).
    expect(negotiateLocale({ cookie: "fr-FR" })).toBe("fr-FR");
    expect(negotiateLocale({ acceptLanguage: "fr-FR,fr;q=0.9" })).toBe("en-US");
    expect(parseAcceptLanguage("en;q=0.1, es")).toEqual(["es", "en"]);
  });
});

describe("console copy", () => {
  function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? files(join(dir, e.name))
        : /\.tsx?$/.test(e.name)
          ? [join(dir, e.name)]
          : [],
    );
  }

  it("client components read only the client namespaces", () => {
    const clients = [...files(join(appRoot, "app")), ...files(join(appRoot, "components"))].filter(
      (f) => readFileSync(f, "utf8").startsWith('"use client"'),
    );
    for (const file of clients) {
      for (const match of readFileSync(file, "utf8").matchAll(/useTranslations\("([a-zA-Z]+)/g)) {
        expect(CLIENT_NAMESPACES, file).toContain(match[1]);
      }
    }
  });

  it("never uses the service role", () => {
    for (const file of [...files(join(appRoot, "app")), ...files(join(appRoot, "lib"))]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/SERVICE_ROLE|service_role/);
    }
  });
});
