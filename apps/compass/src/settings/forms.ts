/**
 * The checks the identity settings forms run before they save (Section 4.5.6 items 1 to 5, ADR 0070). They are
 * the rules Atlas and Gateway apply to the same fields, which the database enforces again: the person_profiles,
 * person_* list and people check constraints and the handle guard (0860, 1340), Supabase Auth's password settings
 * (supabase/config.toml), and the factor and recovery code formats of A77 and A99. Each failure names the message
 * key the screen shows under the field, so a refused value never leaves the phone.
 */
import { looksLikeRecoveryCode } from "@xos/data/account-security";
import { Constants } from "@xos/data/database.types";

/** Field name to the message key of what is wrong with it. */
export type FieldErrors = Readonly<Record<string, string>>;

export type Checked<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: FieldErrors };

const pass = <T>(value: T): Checked<T> => ({ ok: true, value });
const fail = <T>(errors: FieldErrors): Checked<T> => ({ ok: false, errors });

/** Trimmed text, or null when blank. */
export function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Optional text up to `max` characters: null when blank, false when too long. */
function optionalText(value: string, max: number): string | null | false {
  const text = blankToNull(value);
  if (text === null) return null;
  return text.length <= max ? text : false;
}

// Profile -------------------------------------------------------------------------------------------------------------

export const RATE_UNITS = Constants.app.Enums.rate_unit;
export type RateUnit = (typeof RATE_UNITS)[number];

/** The profile facts as typed into the form. */
export interface ProfileFactsInput {
  readonly handle: string;
  readonly preferredName: string;
  readonly pronouns: string;
  readonly headline: string;
  readonly bio: string;
  readonly city: string;
  readonly countryCode: string;
  readonly rate: string;
  readonly rateCurrency: string;
  readonly rateUnit: string;
}

/** The profile facts as app.person_profiles columns. */
export interface ProfileFacts {
  readonly handle: string;
  readonly preferred_name: string | null;
  readonly pronouns: string | null;
  readonly headline: string | null;
  readonly bio: string | null;
  readonly city: string | null;
  readonly country_code: string | null;
  readonly rate_minor: number | null;
  readonly rate_currency: string | null;
  readonly rate_unit: RateUnit | null;
}

/** 3 to 40 lowercase letters, digits and single hyphens, starting and ending with a letter or digit (0860). */
export function isHandle(value: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])$/.test(value) && !value.includes("--");
}

/** Digits after the decimal mark in a currency's minor unit (USD 2, JPY 0), or null for an unknown currency. */
export function currencyDigits(currency: string): number | null {
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  try {
    return (
      new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return null;
  }
}

const P = "profiles.errors";

/** Checks the profile facts the way Atlas's profile form does; a rate is in its currency's minor units. */
export function checkProfileFacts(input: ProfileFactsInput): Checked<ProfileFacts> {
  const errors: Record<string, string> = {};
  const handle = input.handle.trim().toLowerCase();
  if (!isHandle(handle)) errors["handle"] = `${P}.handle_format`;
  const limited = (field: keyof ProfileFactsInput, max: number): string | null => {
    const value = optionalText(input[field], max);
    if (value === false) {
      errors[field] = `${P}.${field}`;
      return null;
    }
    return value;
  };
  const preferredName = limited("preferredName", 100);
  const pronouns = limited("pronouns", 40);
  const headline = limited("headline", 120);
  const bio = limited("bio", 2000);
  const city = limited("city", 100);
  const country = blankToNull(input.countryCode)?.toUpperCase() ?? null;
  if (country !== null && !/^[A-Z]{2}$/.test(country)) errors["countryCode"] = `${P}.countryCode`;

  let rateMinor: number | null = null;
  let rateCurrency: string | null = null;
  let rateUnit: RateUnit | null = null;
  const rate = blankToNull(input.rate);
  if (rate !== null) {
    rateCurrency = blankToNull(input.rateCurrency)?.toUpperCase() ?? null;
    const unit = RATE_UNITS.find((u) => u === input.rateUnit) ?? null;
    const digits = rateCurrency === null ? null : currencyDigits(rateCurrency);
    if (!/^\d{1,12}(\.\d{1,4})?$/.test(rate)) errors["rate"] = `${P}.rate`;
    else if (rateCurrency === null || unit === null) errors["rate"] = `${P}.rateIncomplete`;
    else if (digits === null) errors["rateCurrency"] = `${P}.rateCurrency`;
    else if ((rate.split(".")[1]?.length ?? 0) > digits) errors["rate"] = `${P}.rateDecimals`;
    else {
      // Null means no published rate, never zero (Section 7.1); the amount is kept in minor units.
      rateMinor = Math.round(Number(rate) * 10 ** digits);
      rateUnit = unit;
    }
  }
  if (Object.keys(errors).length > 0) return fail(errors);
  return pass({
    handle,
    preferred_name: preferredName,
    pronouns,
    headline,
    bio,
    city,
    country_code: country,
    rate_minor: rateMinor,
    rate_currency: rateMinor === null ? null : rateCurrency,
    rate_unit: rateMinor === null ? null : rateUnit,
  });
}

/** The rate as the form shows it: minor units back to an amount in the currency's digits. */
export function rateText(
  minor: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (minor === null || minor === undefined) return "";
  const digits = currencyDigits(currency ?? "USD") ?? 2;
  return digits === 0 ? String(minor) : (minor / 10 ** digits).toFixed(digits);
}

/** The columns of `next` whose value differs from the saved row, so a save sends only what changed. */
export function changedColumns(
  row: Readonly<Record<string, unknown>>,
  next: object,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(next).filter(([column, value]) => (row[column] ?? null) !== value),
  );
}

// Profile lists ---------------------------------------------------------------------------------------------------------

export const PROFICIENCIES = Constants.app.Enums.language_proficiency;
export type Proficiency = (typeof PROFICIENCIES)[number];

/** A canon category URID, such as 0101.01.02. */
export function checkSkill(catUrid: string): Checked<{ readonly cat_urid: string }> {
  return /^\d{4}\.\d{2}\.\d{2}$/.test(catUrid)
    ? pass({ cat_urid: catUrid })
    : fail({ catUrid: `${P}.catUrid` });
}

/** A BCP 47 language tag as person_languages stores it (en, es, pt-BR, zh-Hant-TW), with a proficiency. */
export function checkLanguage(
  tag: string,
  proficiency: string,
): Checked<{ readonly language_tag: string; readonly proficiency: Proficiency }> {
  const parts = tag.trim().replace(/_/g, "-").split("-");
  // Case as the column wants it: language lowercase, script title case, region uppercase.
  const normalized = parts
    .map((part, i) =>
      i === 0
        ? part.toLowerCase()
        : part.length === 4
          ? `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`
          : part.toUpperCase(),
    )
    .join("-");
  const level = PROFICIENCIES.find((p) => p === proficiency);
  if (!/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$/.test(normalized)) {
    return fail({ tag: `${P}.tag` });
  }
  return level ? pass({ language_tag: normalized, proficiency: level }) : fail({ tag: `${P}.tag` });
}

/** A link with text up to 60 characters and an https address (person_links). */
export function checkLink(
  label: string,
  url: string,
): Checked<{ readonly label: string; readonly url: string }> {
  const text = label.trim();
  const address = url.trim();
  const ok =
    text.length >= 1 &&
    text.length <= 60 &&
    /^https:\/\/\S{3,}$/.test(address) &&
    address.length <= 2000;
  return ok ? pass({ label: text, url: address }) : fail({ url: `${P}.url` });
}

/** A calendar date typed as YYYY-MM-DD that exists. */
export function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** A self-entered certification: name, issuer, issue date and an expiry on or after it (person_certifications). */
export function checkCertification(input: {
  readonly name: string;
  readonly issuingBody: string;
  readonly issuedOn: string;
  readonly expiresOn: string;
}): Checked<{
  readonly name: string;
  readonly issuing_body: string;
  readonly issued_on: string;
  readonly expires_on: string | null;
}> {
  const name = input.name.trim();
  const issuer = input.issuingBody.trim();
  const issued = input.issuedOn.trim();
  const expires = blankToNull(input.expiresOn);
  if (
    name.length < 1 ||
    name.length > 200 ||
    issuer.length < 1 ||
    issuer.length > 200 ||
    !isDate(issued) ||
    (expires !== null && !isDate(expires))
  ) {
    return fail({ certification: `${P}.certification` });
  }
  if (expires !== null && expires < issued) {
    return fail({ certification: `${P}.certificationDates` });
  }
  return pass({ name, issuing_body: issuer, issued_on: issued, expires_on: expires });
}

// Privacy -------------------------------------------------------------------------------------------------------------

export const VISIBILITIES = Constants.app.Enums.profile_visibility;
export type Visibility = (typeof VISIBILITIES)[number];

/** Who sees the profile. Only a Public profile may be indexed by search engines (person_profiles_indexing_public). */
export function privacyColumns(input: {
  readonly visibility: Visibility;
  readonly marketplaceDiscoverable: boolean;
  readonly searchIndexing: boolean;
}): {
  readonly visibility: Visibility;
  readonly marketplace_discoverable: boolean;
  readonly search_indexing: boolean;
} {
  return {
    visibility: input.visibility,
    marketplace_discoverable: input.marketplaceDiscoverable,
    search_indexing: input.searchIndexing && input.visibility === "Public",
  };
}

// Account -------------------------------------------------------------------------------------------------------------

/** The full name, 1 to 200 characters (people_full_name_length). */
export function checkFullName(value: string): Checked<{ readonly full_name: string }> {
  const name = value.trim();
  return name.length >= 1 && name.length <= 200
    ? pass({ full_name: name })
    : fail({ fullName: "gateway.profile.errors.name" });
}

/**
 * The optional given and family names, up to 100 characters each, blank clearing one (1340; the rule of
 * parseNamePartsForm in @xos/data/work-details-forms, which Atlas and Gateway share).
 */
export function checkNameParts(
  givenName: string,
  familyName: string,
): Checked<{ readonly given_name: string | null; readonly family_name: string | null }> {
  const given = optionalText(givenName, 100);
  const family = optionalText(familyName, 100);
  const errors: Record<string, string> = {};
  if (given === false) errors["givenName"] = "compassSettings.account.errors.namePart";
  if (family === false) errors["familyName"] = "compassSettings.account.errors.namePart";
  if (given === false || family === false) return fail(errors);
  return pass({ given_name: given, family_name: family });
}

// Security ------------------------------------------------------------------------------------------------------------

/** Supabase Auth's password settings (supabase/config.toml): 12 characters or more, letters and digits. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

/** Product names a password may not contain: the context-specific word list of ASVS V6.2.11 (A22-010). */
const PRODUCT_WORDS = ["xos", "atlas", "gateway", "compass", "ghxstship"] as const;

/** True when a password holds a product name, the email's local part or a part of the person's name. */
export function passwordHasContextWords(
  password: string,
  details: { readonly email?: string | null; readonly fullName?: string | null },
): boolean {
  const local = (details.email ?? "").split("@")[0] ?? "";
  const words = [
    local,
    ...(details.fullName ?? "").split(/[\s.\-_'@]+/u),
    ...local.split(/[.\-_+]+/u),
  ]
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 4);
  const lowered = password.toLowerCase();
  return [...PRODUCT_WORDS, ...words].some((word) => lowered.includes(word));
}

const S = "compassSettings.security.errors";

/**
 * A new password, typed twice: the rules Atlas and Gateway check at sign-up (apps/atlas/lib/auth/password.ts), which
 * Supabase Auth enforces again and, on the hosted project, checks against breach lists.
 */
export function checkNewPassword(
  password: string,
  confirm: string,
  details: { readonly email?: string | null; readonly fullName?: string | null },
): Checked<{ readonly password: string }> {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    return fail({ password: `${S}.passwordLength` });
  }
  if (!/\p{L}/u.test(password) || !/\p{Nd}/u.test(password)) {
    return fail({ password: `${S}.passwordRule` });
  }
  if (passwordHasContextWords(password, details)) return fail({ password: `${S}.passwordContext` });
  if (confirm !== password) return fail({ confirm: `${S}.passwordMismatch` });
  return pass({ password });
}

/** The name of a second factor or passkey, 1 to 80 characters (A77, migration 1331). */
export function checkFactorLabel(value: string): Checked<{ readonly label: string }> {
  const label = value.trim();
  return label.length >= 1 && label.length <= 80
    ? pass({ label })
    : fail({ label: "authSecurity.errors.factor_label_length" });
}

/** A 6-digit code from an authenticator app, spaces ignored. */
export function checkTotpCode(value: string): Checked<{ readonly code: string }> {
  const code = value.replace(/\s/g, "");
  return /^\d{6}$/.test(code) ? pass({ code }) : fail({ code: "authSecurity.errors.code_invalid" });
}

/** A recovery code as typed, abcde-23456 with the hyphen optional (A99). */
export function checkRecoveryCode(value: string): Checked<{ readonly code: string }> {
  const code = value.replace(/\s/g, "");
  return looksLikeRecoveryCode(code)
    ? pass({ code })
    : fail({ code: "authSecurity.errors.recovery_invalid" });
}

/** The 6-digit code Supabase Auth emails for a password change on a session older than a day. */
export function checkEmailCode(value: string): Checked<{ readonly nonce: string }> {
  const nonce = value.replace(/\s/g, "");
  return /^\d{6,10}$/.test(nonce) ? pass({ nonce }) : fail({ nonce: `${S}.emailCode` });
}
