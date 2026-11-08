import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  errorKey,
  expiryFrom,
  failed,
  field,
  fromResult,
  IDLE,
  localDateTime,
} from "../lib/action-state";
import { legalQueueTitle } from "../lib/legal-queue-title";
import { secondFactorErrorKey, shownError, signInErrorKey } from "../lib/auth/errors";
import { safeNext } from "../lib/auth/redirect";
import { EnvError, parseEnv, passwordSignIn, secureSite } from "../lib/env";
import {
  formattingLocale,
  localeDirection,
  negotiateLocale,
  parseAcceptLanguage,
} from "../i18n/negotiate";
import { CLIENT_NAMESPACES, sourceMessagesFor, uiMessages } from "../i18n/request";
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
    const production = true;
    expect(negotiateLocale({ cookie: "es-US", production })).toBe("es-US");
    expect(negotiateLocale({ acceptLanguage: "es-MX,es;q=0.9,en;q=0.5", production })).toBe(
      "es-US",
    );
    expect(negotiateLocale({ cookie: "en-XA", acceptLanguage: "fr", production })).toBe("en-US");
    // Beta locales come from the person's choice only (ADR 0053), and only while their territory is open (ADR 0160).
    expect(negotiateLocale({ cookie: "fr-FR", production, offered: ["en-US", "fr-FR"] })).toBe(
      "fr-FR",
    );
    expect(negotiateLocale({ cookie: "fr-FR", production })).toBe("en-US");
    expect(negotiateLocale({ acceptLanguage: "fr-FR,fr;q=0.9", production })).toBe("en-US");
    expect(parseAcceptLanguage("en;q=0.1, es")).toEqual(["es", "en"]);
  });

  it("offers the pseudo-locales from the cookie outside production only", () => {
    expect(negotiateLocale({ cookie: "en-XA", production: false })).toBe("en-XA");
    expect(negotiateLocale({ cookie: "ar-XB", production: false })).toBe("ar-XB");
    expect(negotiateLocale({ cookie: "ar-XB", production: true })).toBe("en-US");
    expect(localeDirection("ar-XB")).toBe("rtl");
    expect(localeDirection("en-XA")).toBe("ltr");
    // Dates and numbers format as en-US while the messages stay pseudo.
    expect(formattingLocale("en-XA")).toBe("en-US");
    expect(formattingLocale("es-US")).toBe("es-US");
    expect(sourceMessagesFor("en-XA").console.name).toMatch(/^\[.+ ·+\]$/);
    expect(uiMessages("en-XA")?.["action.cancel"]).toMatch(/^\[Çàñçéļ ·+\]$/);
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

describe("legal queue times and titles", () => {
  it("passes on a real date as typed, for the database to read in the queue's zone", () => {
    expect(localDateTime("2027-03-20T17:00")).toBe("2027-03-20T17:00");
    expect(localDateTime("2026-11-01T01:30:00")).toBe("2026-11-01T01:30:00");
    expect(localDateTime("")).toBeNull();
    expect(localDateTime("2027-02-31T10:00")).toBeNull();
    expect(localDateTime("2027-03-20T25:00")).toBeNull();
    expect(localDateTime("2027-03-20 17:00")).toBeNull();
    expect(localDateTime("next Tuesday")).toBeNull();
  });

  const words = {
    t: (key: string, values?: Record<string, string | number>) =>
      `${key}${values ? JSON.stringify(values) : ""}`,
    label: (group: string, value: string) => `${group}.${value}`,
  };
  const item = (
    ruleCode: string,
    title: string,
    liveTitle: string | null = null,
    counted: number | null = null,
  ) => ({ ruleCode, title, liveTitle, counted }) as Parameters<typeof legalQueueTitle>[0];

  it("keeps what an operator typed and words a fed item from the catalog, so no English is shown in Spanish", () => {
    expect(legalQueueTitle(item("security_report", "XSS in search"), words)).toBe("XSS in search");
    expect(legalQueueTitle(item("listing_report", "Marketplace listing", "Riggers"), words)).toBe(
      "Riggers",
    );
    expect(legalQueueTitle(item("moderation_appeal", "Marketplace listing"), words)).toBe(
      "legalQueue.fedTitles.listing",
    );
    expect(legalQueueTitle(item("repeat_infringer_review", "3", null, 3), words)).toBe(
      'legalQueue.fedTitles.repeat{"count":3}',
    );
    expect(legalQueueTitle(item("dsar_customer_register", "Erasure"), words)).toBe(
      "legalQueue.requestTypes.Erasure",
    );
    expect(legalQueueTitle(item("undelivered_notice", "Moderation notice"), words)).toBe(
      "legalQueue.fedTitles.undelivered",
    );
    expect(legalQueueTitle(item("queue_feed_failure", "sources"), words)).toBe(
      'legalQueue.fedTitles.feed{"feed":"legalQueue.feeds.sources"}',
    );
  });
});

/** The legal queue (ADR 0167): every clock in the migration has its words, and no copy promises a second person. */
describe("legal queue copy", () => {
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const messages = (locale: string, namespace: string) =>
    JSON.parse(
      readFileSync(join(repoRoot, `packages/i18n/messages/${locale}/${namespace}.json`), "utf8"),
    ) as Record<string, Record<string, Record<string, Record<string, string>>>>;
  const migration = readFileSync(
    join(repoRoot, "supabase/migrations/6860_legal_queue.sql"),
    "utf8",
  );
  const rules = [
    ...migration.matchAll(
      /^ {2}\('([a-z_]+)', '[^']+', '(?:Statute|Published Promise|Internal Target|Customer Clock)'/gm,
    ),
  ].map((m) => m[1] ?? "");

  it.each(["en-US", "es-US"])("labels and sources every rule in %s", (locale) => {
    expect(rules).toContain("dmca_counter_notice");
    const catalog = messages(locale, "console")["legalQueue"]?.["rules"] ?? {};
    expect(Object.keys(catalog).sort()).toEqual([...rules].sort());
    for (const rule of rules) {
      expect(catalog[rule]?.["label"], rule).toBeTruthy();
      expect(catalog[rule]?.["source"], rule).toBeTruthy();
    }
  });

  it.each(["en-US", "es-US"])("names every refusal the queue raises in %s", (locale) => {
    const sql = ["6165_legal_queue", "6166_legal_queue_console", "6168_one_person_appeal_rule"]
      .map((file) => readFileSync(join(repoRoot, `supabase/migrations/${file}.sql`), "utf8"))
      .join("\n");
    const raised = new Set(
      [...sql.matchAll(/private\.refuse\('([a-z_]+)'/g)].map((m) => m[1] ?? ""),
    );
    expect(raised.size).toBeGreaterThan(10);
    const refusals = messages(locale, "console")["refusals"] as unknown as Record<string, string>;
    for (const rule of raised) expect(refusals[rule], rule).toBeTruthy();
    expect(refusals["moderation_appeal_same_operator"]).toBeUndefined();
  });

  it.each(["en-US", "es-US"])("words every enum value and fed title in %s", (locale) => {
    const lq = messages(locale, "console")["legalQueue"] as unknown as Record<
      string,
      Record<string, string>
    >;
    const values = (type: string) => {
      const block =
        new RegExp(`create type app\\.${type} as enum \\(([^)]+)\\)`).exec(migration)?.[1] ?? "";
      return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? "");
    };
    for (const [type, group] of [
      ["legal_queue_matter", "matters"],
      ["legal_queue_state", "states"],
      ["legal_queue_event_kind", "events"],
      ["legal_queue_basis", "bases"],
    ] as const) {
      expect(values(type).length).toBeGreaterThan(2);
      for (const value of values(type))
        expect(lq[group]?.[value], `${group}.${value}`).toBeTruthy();
    }
    for (const feed of [
      "moderation_appeals",
      "listing_reports",
      "dsar_requests",
      "moderation_notices",
      "sources",
    ]) {
      expect(lq["feeds"]?.[feed], feed).toBeTruthy();
      expect(migration).toContain(`'${feed}'`);
    }
    const email = messages(locale, "email")["legal_clock_alert"]?.["matters"] as unknown as Record<
      string,
      string
    >;
    for (const matter of values("legal_queue_matter")) expect(email[matter], matter).toBeTruthy();
  });

  it.each(["en-US", "es-US"])("promises no second person on an appeal in %s", (locale) => {
    const moderation = messages(locale, "console")["moderation"] as unknown as Record<
      string,
      string
    >;
    expect(`${moderation["intro"]} ${moderation["appealOwn"]}`).not.toMatch(
      /another operator|otra persona del equipo/i,
    );
  });
});
