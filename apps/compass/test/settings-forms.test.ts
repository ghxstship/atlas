import { getMessages } from "@xos/i18n";
import { describe, expect, it } from "vitest";
import {
  changedColumns,
  checkCertification,
  checkEmailCode,
  checkFactorLabel,
  checkFullName,
  checkLanguage,
  checkLink,
  checkNameParts,
  checkNewPassword,
  checkProfileFacts,
  checkRecoveryCode,
  checkSkill,
  checkTotpCode,
  currencyDigits,
  isDate,
  isHandle,
  privacyColumns,
  rateText,
  type ProfileFactsInput,
} from "../src/settings/forms";

/**
 * The identity settings forms check what Atlas, Gateway and the database check (A110, ADR 0070), so a value the
 * server would refuse never leaves the phone, and each failure names a message both locales carry.
 */

const facts = (patch: Partial<ProfileFactsInput> = {}): ProfileFactsInput => ({
  handle: "ana-ruiz",
  preferredName: "",
  pronouns: "",
  headline: "Lead rigger",
  bio: "",
  city: "Austin",
  countryCode: "us",
  rate: "",
  rateCurrency: "USD",
  rateUnit: "Day",
  ...patch,
});

function message(key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      getMessages("es-US"),
    );
}

/** Every error a failed check names is a message in Spanish (and so in English, which has the same keys). */
function expectTranslated(errors: Readonly<Record<string, string>>) {
  for (const key of Object.values(errors)) expect(typeof message(key), key).toBe("string");
}

describe("profile facts", () => {
  it("lowercases the handle, uppercases the country and blanks empty fields to null", () => {
    const checked = checkProfileFacts(facts({ handle: "  Ana-Ruiz " }));
    expect(checked).toEqual({
      ok: true,
      value: {
        handle: "ana-ruiz",
        preferred_name: null,
        pronouns: null,
        headline: "Lead rigger",
        bio: null,
        city: "Austin",
        country_code: "US",
        rate_minor: null,
        rate_currency: null,
        rate_unit: null,
      },
    });
  });

  it("takes a handle of 3 to 40 lowercase letters, digits and single hyphens (0860)", () => {
    expect(isHandle("ana")).toBe(true);
    expect(isHandle("a".repeat(40))).toBe(true);
    for (const bad of ["an", "a".repeat(41), "-ana", "ana-", "an--a", "ana_ruiz", "Ana"]) {
      expect(isHandle(bad), bad).toBe(false);
    }
    const refused = checkProfileFacts(facts({ handle: "an--a" }));
    expect(refused).toEqual({ ok: false, errors: { handle: "profiles.errors.handle_format" } });
  });

  it("keeps each fact within its column's length", () => {
    const refused = checkProfileFacts(
      facts({
        preferredName: "x".repeat(101),
        pronouns: "x".repeat(41),
        headline: "x".repeat(121),
        bio: "x".repeat(2001),
        city: "x".repeat(101),
        countryCode: "USA",
      }),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(Object.keys(refused.errors).sort()).toEqual(
      ["bio", "city", "countryCode", "headline", "preferredName", "pronouns"].sort(),
    );
    expectTranslated(refused.errors);
  });

  it("keeps a rate in its currency's minor units, and null means no rate, never zero", () => {
    const usd = checkProfileFacts(facts({ rate: "450.50", rateCurrency: "usd", rateUnit: "Day" }));
    expect(usd.ok && usd.value).toMatchObject({
      rate_minor: 45050,
      rate_currency: "USD",
      rate_unit: "Day",
    });
    const yen = checkProfileFacts(facts({ rate: "30000", rateCurrency: "JPY", rateUnit: "Hour" }));
    expect(yen.ok && yen.value.rate_minor).toBe(30000);
    expect(checkProfileFacts(facts({ rate: "0", rateCurrency: "USD" })).ok).toBe(true);
  });

  it("names what is wrong with a rate", () => {
    const errors = (patch: Partial<ProfileFactsInput>) => {
      const checked = checkProfileFacts(facts(patch));
      return checked.ok ? {} : checked.errors;
    };
    expect(errors({ rate: "four hundred" })).toEqual({ rate: "profiles.errors.rate" });
    expect(errors({ rate: "450", rateCurrency: "" })).toEqual({
      rate: "profiles.errors.rateIncomplete",
    });
    expect(errors({ rate: "450", rateUnit: "Month" })).toEqual({
      rate: "profiles.errors.rateIncomplete",
    });
    expect(errors({ rate: "450", rateCurrency: "ZZZ1" })).toEqual({
      rateCurrency: "profiles.errors.rateCurrency",
    });
    expect(errors({ rate: "450.5", rateCurrency: "JPY" })).toEqual({
      rate: "profiles.errors.rateDecimals",
    });
    expectTranslated({ a: "profiles.errors.rateDecimals", b: "profiles.errors.rateIncomplete" });
  });

  it("shows a stored rate back in the currency's digits", () => {
    expect(rateText(45050, "USD")).toBe("450.50");
    expect(rateText(30000, "JPY")).toBe("30000");
    expect(rateText(null, "USD")).toBe("");
    expect(currencyDigits("usd")).toBeNull();
    expect(currencyDigits("BHD")).toBe(3);
  });

  it("sends only the columns that changed", () => {
    const row = { id: "p1", handle: "ana-ruiz", headline: "Lead rigger", city: null };
    expect(
      changedColumns(row, { handle: "ana-ruiz", headline: "Head rigger", city: null }),
    ).toEqual({
      headline: "Head rigger",
    });
    expect(changedColumns(row, { handle: "ana-ruiz" })).toEqual({});
  });
});

describe("profile lists", () => {
  it("takes a canon category URID as a skill", () => {
    expect(checkSkill("0101.01.02")).toEqual({ ok: true, value: { cat_urid: "0101.01.02" } });
    expect(checkSkill("rigging")).toEqual({
      ok: false,
      errors: { catUrid: "profiles.errors.catUrid" },
    });
  });

  it("writes a language tag as person_languages stores it, with a proficiency", () => {
    expect(checkLanguage("PT_br", "Fluent")).toEqual({
      ok: true,
      value: { language_tag: "pt-BR", proficiency: "Fluent" },
    });
    expect(
      checkLanguage("zh-hant-tw", "Native").ok && checkLanguage("zh-hant-tw", "Native"),
    ).toEqual({
      ok: true,
      value: { language_tag: "zh-Hant-TW", proficiency: "Native" },
    });
    expect(checkLanguage("es-419", "Basic").ok).toBe(true);
    expect(checkLanguage("english", "Fluent").ok).toBe(false);
    expect(checkLanguage("es", "Excellent").ok).toBe(false);
  });

  it("takes a link with text up to 60 characters and an https address", () => {
    expect(checkLink(" Portfolio ", " https://ana.example.com ")).toEqual({
      ok: true,
      value: { label: "Portfolio", url: "https://ana.example.com" },
    });
    for (const [label, url] of [
      ["", "https://ana.example.com"],
      ["x".repeat(61), "https://ana.example.com"],
      ["Portfolio", "http://ana.example.com"],
      ["Portfolio", "https://a b"],
    ] as const) {
      expect(checkLink(label, url), `${label} ${url}`).toEqual({
        ok: false,
        errors: { url: "profiles.errors.url" },
      });
    }
  });

  it("takes a certification with an issue date and an expiry on or after it", () => {
    const base = {
      name: "Rigging Level 2",
      issuingBody: "ETCP",
      issuedOn: "2026-05-01",
      expiresOn: "",
    };
    expect(checkCertification(base)).toEqual({
      ok: true,
      value: {
        name: "Rigging Level 2",
        issuing_body: "ETCP",
        issued_on: "2026-05-01",
        expires_on: null,
      },
    });
    expect(checkCertification({ ...base, expiresOn: "2029-05-01" }).ok).toBe(true);
    expect(checkCertification({ ...base, expiresOn: "2025-05-01" })).toEqual({
      ok: false,
      errors: { certification: "profiles.errors.certificationDates" },
    });
    expect(checkCertification({ ...base, issuedOn: "2026-02-30" })).toEqual({
      ok: false,
      errors: { certification: "profiles.errors.certification" },
    });
    expect(checkCertification({ ...base, name: " " }).ok).toBe(false);
    expect(isDate("2028-02-29")).toBe(true);
    expect(isDate("2027-02-29")).toBe(false);
    expect(isDate("05/01/2026")).toBe(false);
  });
});

describe("privacy", () => {
  it("indexes only a Public profile (person_profiles_indexing_public)", () => {
    expect(
      privacyColumns({
        visibility: "Network",
        marketplaceDiscoverable: true,
        searchIndexing: true,
      }),
    ).toEqual({ visibility: "Network", marketplace_discoverable: true, search_indexing: false });
    expect(
      privacyColumns({
        visibility: "Public",
        marketplaceDiscoverable: false,
        searchIndexing: true,
      }),
    ).toEqual({ visibility: "Public", marketplace_discoverable: false, search_indexing: true });
  });
});

describe("account", () => {
  it("takes a full name of 1 to 200 characters", () => {
    expect(checkFullName("  Ana Ruiz ")).toEqual({ ok: true, value: { full_name: "Ana Ruiz" } });
    expect(checkFullName(" ")).toEqual({
      ok: false,
      errors: { fullName: "gateway.profile.errors.name" },
    });
    expect(checkFullName("x".repeat(201)).ok).toBe(false);
    expectTranslated({ name: "gateway.profile.errors.name" });
  });

  it("clears a blank given or family name and refuses one over 100 characters", () => {
    expect(checkNameParts(" Ana ", "")).toEqual({
      ok: true,
      value: { given_name: "Ana", family_name: null },
    });
    const refused = checkNameParts("x".repeat(101), "Ruiz");
    expect(refused).toEqual({
      ok: false,
      errors: { givenName: "compassSettings.account.errors.namePart" },
    });
    if (!refused.ok) expectTranslated(refused.errors);
  });
});

describe("security", () => {
  const me = { email: "ana.ruiz@example.com", fullName: "Ana Ruiz" };

  it("takes a password of 12 to 256 characters with letters and digits, typed twice", () => {
    expect(checkNewPassword("river4tangerine", "river4tangerine", me)).toEqual({
      ok: true,
      value: { password: "river4tangerine" },
    });
    const errors = (password: string, confirm = password) => {
      const checked = checkNewPassword(password, confirm, me);
      return checked.ok ? {} : checked.errors;
    };
    expect(errors("short4you")).toEqual({
      password: "compassSettings.security.errors.passwordLength",
    });
    expect(errors(`a1${"x".repeat(255)}`)).toEqual({
      password: "compassSettings.security.errors.passwordLength",
    });
    expect(errors("onlyletterslong")).toEqual({
      password: "compassSettings.security.errors.passwordRule",
    });
    expect(errors("123456789012")).toEqual({
      password: "compassSettings.security.errors.passwordRule",
    });
    expect(errors("river4tangerine", "river4tangerinE")).toEqual({
      confirm: "compassSettings.security.errors.passwordMismatch",
    });
    expectTranslated({
      a: "compassSettings.security.errors.passwordLength",
      b: "compassSettings.security.errors.passwordRule",
      c: "compassSettings.security.errors.passwordMismatch",
    });
  });

  it("refuses a password holding the person's name, email or a product name (ASVS V6.2.11)", () => {
    for (const password of [
      "compass2026rocks",
      "ruizrules2026",
      "anaruiz-1234567",
      "xyzatlas12345",
    ]) {
      expect(checkNewPassword(password, password, me), password).toEqual({
        ok: false,
        errors: { password: "compassSettings.security.errors.passwordContext" },
      });
    }
  });

  it("takes a factor name of 1 to 80 characters, a 6-digit code and a recovery code", () => {
    expect(checkFactorLabel(" Work phone ")).toEqual({ ok: true, value: { label: "Work phone" } });
    expect(checkFactorLabel("x".repeat(81)).ok).toBe(false);
    expect(checkTotpCode("123 456")).toEqual({ ok: true, value: { code: "123456" } });
    expect(checkTotpCode("12345").ok).toBe(false);
    expect(checkRecoveryCode("abcde-23456")).toEqual({ ok: true, value: { code: "abcde-23456" } });
    expect(checkRecoveryCode("abcde 23456").ok).toBe(true);
    expect(checkRecoveryCode("abcd-2345").ok).toBe(false);
    expect(checkEmailCode(" 123456 ")).toEqual({ ok: true, value: { nonce: "123456" } });
    expect(checkEmailCode("12ab")).toEqual({
      ok: false,
      errors: { nonce: "compassSettings.security.errors.emailCode" },
    });
    expectTranslated({
      a: "authSecurity.errors.factor_label_length",
      b: "authSecurity.errors.code_invalid",
      c: "authSecurity.errors.recovery_invalid",
    });
  });
});
