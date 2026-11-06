import type { XosClient } from "./client.ts";
import type { DatabaseErrorLike } from "./result.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Cookie consent, Global Privacy Control and the account age rule (Sections 14.3 and 14.9, finding
 * A65-014; migrations 0501, 1381 and 6155), shared by the Atlas and Gateway shells and, for the age
 * rule and what a sign-in still owes, Compass.
 *
 * What the shells set, and why a banner is needed (legal/cookie-policy.md section 3):
 * - Strictly necessary: the Supabase Auth session, this consent cookie, Gateway's acting account
 *   and Atlas's View as preview. No consent.
 * - Preferences: language, theme, the workspace filter and the last-opened org. Without consent they
 *   last for the visit only (session cookies); with it, 12 months.
 * - Performance: none. The browser reports errors through the shell's own endpoint, never Sentry,
 *   and no analytics run. The banner still records the choice so a future cookie starts blocked.
 * - Marketing: none, never offered.
 * A browser sending Global Privacy Control (`Sec-GPC: 1`) refuses every non-essential category; the
 * shells record the signal once and do not show the banner.
 */

/** The consent cookie: version, random visitor id, preferences, performance and the GPC flag. */
export const CONSENT_COOKIE = "xos-consent";
/** Policy and banner version recorded with each decision (legal/index.yaml cookie-policy). */
export const CONSENT_BANNER_VERSION = "cookie-policy 1.0.0-draft";
/** How long the consent choice is remembered before the banner asks again. */
export const CONSENT_MAX_AGE = 60 * 60 * 24 * 365;
/** How long a Preferences cookie lasts once Preferences are allowed. */
export const PREFERENCE_MAX_AGE = 60 * 60 * 24 * 365;

export interface CookieConsent {
  readonly visitorId: string;
  readonly preferences: boolean;
  readonly performance: boolean;
  /** The decision came from a Global Privacy Control signal. */
  readonly gpc: boolean;
}

const VISITOR = /^[0-9a-f]{32}$/;

/** A random visitor id; only its SHA-256 is stored server-side. */
export function newVisitorId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

/** The cookie value: `1.<visitor>.<preferences><performance>.<gpc>` with 0 or 1 flags. */
export function serializeConsent(consent: CookieConsent): string {
  const bit = (b: boolean) => (b ? "1" : "0");
  return `1.${consent.visitorId}.${bit(consent.preferences)}${bit(consent.performance)}.${bit(consent.gpc)}`;
}

/** The consent a cookie value holds, or null when it is missing or not one this version wrote. */
export function parseConsent(value: string | undefined | null): CookieConsent | null {
  const match = /^1\.([0-9a-f]{32})\.([01])([01])\.([01])$/.exec(value ?? "");
  if (!match || !VISITOR.test(match[1] as string)) return null;
  return {
    visitorId: match[1] as string,
    preferences: match[2] === "1",
    performance: match[3] === "1",
    gpc: match[4] === "1",
  };
}

/** True when the browser sends Global Privacy Control (`Sec-GPC: 1`). */
export function sendsGpc(headers: { get(name: string): string | null }): boolean {
  return headers.get("sec-gpc")?.trim() === "1";
}

/** Whether Preferences cookies may last beyond the visit: consented, and no GPC signal now. */
export function preferencesAllowed(consent: CookieConsent | null, gpc: boolean): boolean {
  return consent !== null && consent.preferences && !consent.gpc && !gpc;
}

/**
 * Cookie options for a Preferences cookie: 12 months with consent, otherwise a session cookie that
 * ends with the visit (prior blocking, legal/cookie-policy.md section 2).
 */
export function preferenceCookieOptions(
  allowed: boolean,
  secure: boolean,
): {
  readonly path: "/";
  readonly sameSite: "lax";
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly maxAge?: number;
} {
  return {
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    secure,
    ...(allowed ? { maxAge: PREFERENCE_MAX_AGE } : {}),
  };
}

/** Options for the consent cookie itself (strictly necessary). */
export function consentCookieOptions(secure: boolean) {
  return {
    path: "/",
    sameSite: "lax" as const,
    httpOnly: true,
    secure,
    maxAge: CONSENT_MAX_AGE,
  };
}

type PublicRpc = {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: DatabaseErrorLike | null }>;
};

/**
 * Stores a decision server-side (api_public.record_cookie_consent). A Global Privacy Control signal
 * is recorded in app.privacy_signals and refuses every non-essential category. Answers false when
 * the database refused it (rate limit or malformed visitor id).
 */
export async function recordCookieConsent(
  db: XosClient,
  consent: CookieConsent,
  orgSlug: string | null = null,
): Promise<Result<boolean>> {
  const api = (db as unknown as { schema(name: "api_public"): PublicRpc }).schema("api_public");
  const { data, error } = await api.rpc("record_cookie_consent", {
    p_visitor_id: consent.visitorId,
    p_org_slug: orgSlug,
    p_functional: consent.preferences,
    p_analytics: consent.performance,
    p_marketing: false,
    p_banner_version: CONSENT_BANNER_VERSION,
    p_global_privacy_control: consent.gpc,
  });
  if (error) return fail(toDataError(error));
  return ok(data === true);
}

// Age 18 or older (Section 14.3 Children, Section 14.9 Minors) ----------------------------------

export type AgeSurface = "Atlas" | "Gateway" | "Compass";

/** The minimum account age the Terms state (Terms of Service 3.2), in every app. */
export const MINIMUM_AGE = 18;

/**
 * The two answers to the age question, as a form posts them. The question offers both with equal
 * weight and says nothing of the rule until it is answered: the FTC warns against a box that only
 * invites "I am old enough" (ADR 0156).
 */
export const AGE_OLD_ENOUGH = "18";
export const AGE_UNDER = "under-18";

/** Sign-up metadata that records the answer when the account is created (migrations 1381, 6155). */
export function ageMetadata(surface: AgeSurface): {
  readonly age_confirmed: typeof AGE_OLD_ENOUGH;
  readonly signup_surface: AgeSurface;
} {
  return { age_confirmed: AGE_OLD_ENOUGH, signup_surface: surface };
}

/** Whether the signed-in person has confirmed they are 18 or older. A confirmation at 16 does not count. */
export async function minimumAgeConfirmed(db: XosClient): Promise<Result<boolean>> {
  const { data, error } = await db.rpc("minimum_age_confirmed");
  if (error) return fail(toDataError(error));
  return ok(data === true);
}

/** Records the signed-in person's confirmation (app.confirm_minimum_age); the first one stands. */
export async function confirmMinimumAge(
  db: XosClient,
  surface: AgeSurface,
  clientIp: string | null,
): Promise<Result<string>> {
  const { data, error } = await db.rpc("confirm_minimum_age", {
    p_surface: surface,
    ...(clientIp === null ? {} : { p_client_ip: clientIp }),
  });
  if (error) return fail(toDataError(error));
  return ok(String(data));
}

/** What happened to an account whose holder answered that they are under 18. */
export type AgeRefusal =
  | { readonly outcome: "Account Removed" | "Account Closed" }
  | {
      readonly outcome: "Account Held";
      /** Why deletion could not run: account_delete_legal_hold, _on_shift or _sole_owner. */
      readonly reason: string;
      readonly orgName: string | null;
    };

/**
 * The signed-in person answered that they are under 18 and confirmed it (app.refuse_minimum_age, migration 6155): the
 * account goes, with what XOS itself holds about them, and the refusal is recorded with nothing that names them. After
 * it the session has no sign-in behind it. An account that is held keeps its sign-in, so the caller ends every session.
 */
export async function refuseMinimumAge(
  db: XosClient,
  surface: AgeSurface,
): Promise<Result<AgeRefusal>> {
  const { data, error } = await db.rpc("refuse_minimum_age", { p_surface: surface });
  if (error) return fail(toDataError(error));
  const row = (data ?? {}) as Record<string, unknown>;
  if (row["outcome"] === "Account Held") {
    return ok({
      outcome: "Account Held",
      reason: String(row["reason"] ?? ""),
      orgName: typeof row["org_name"] === "string" ? row["org_name"] : null,
    });
  }
  return ok({
    outcome: row["outcome"] === "Account Closed" ? "Account Closed" : "Account Removed",
  });
}

/**
 * Whether a signed-in request still owes the age question, so a shell's proxy sends it to /auth/age first (ADR 0156). A
 * failed read lets it through: the database still refuses joining an org and AI features until the answer is recorded.
 */
export async function owesAgeAnswer(db: XosClient): Promise<boolean> {
  const age = await minimumAgeConfirmed(db);
  return age.ok && !age.data;
}

/**
 * Someone answered under 18 on a sign-up form, before any account exists: counts the refusal and keeps
 * nothing they typed (api_public.record_age_refusal). A failure never changes what they are told.
 */
export async function recordAgeRefusal(
  db: XosClient,
  surface: AgeSurface,
): Promise<Result<boolean>> {
  const api = (db as unknown as { schema(name: "api_public"): PublicRpc }).schema("api_public");
  const { data, error } = await api.rpc("record_age_refusal", { p_surface: surface });
  if (error) return fail(toDataError(error));
  return ok(data === true);
}

// What a Compass sign-in still owes (migration 6155) --------------------------------------------

/** What the person chose when told what AI features send to a third-party AI provider. */
export type AiChoice = "Allowed" | "Declined";

export interface LegalStanding {
  readonly ageConfirmed: boolean;
  /** Personal documents accepted at any version; a new version comes from the re-acceptance list. */
  readonly acceptedDocuments: readonly string[];
  /** They hold an engagement or a roster entry, or no active membership. */
  readonly workerTermsApply: boolean;
  readonly aiChoice: AiChoice | null;
  /** The version of the words shown with that choice. */
  readonly aiDisclosureVersion: string | null;
  /** A legal hold, an open shift or being an only owner would stop this account closing now. */
  readonly closingBlocked: boolean;
}

export function parseLegalStanding(raw: Record<string, unknown>): LegalStanding {
  const documents = raw["accepted_documents"];
  const choice = raw["ai_choice"];
  const version = raw["ai_disclosure_version"];
  return {
    ageConfirmed: raw["age_confirmed"] === true,
    acceptedDocuments: Array.isArray(documents) ? documents.map(String) : [],
    workerTermsApply: raw["worker_terms_apply"] !== false,
    aiChoice: choice === "Allowed" || choice === "Declined" ? choice : null,
    aiDisclosureVersion: typeof version === "string" ? version : null,
    closingBlocked: raw["closing_blocked"] === true,
  };
}

export async function readLegalStanding(db: XosClient): Promise<Result<LegalStanding>> {
  const { data, error } = await db.rpc("my_legal_standing");
  if (error) return fail(toDataError(error));
  return ok(parseLegalStanding((data ?? {}) as Record<string, unknown>));
}

/** Records the person's AI choice with the version of the words they saw (app.record_ai_choice). */
export async function recordAiChoice(
  db: XosClient,
  input: {
    readonly surface: AgeSurface;
    readonly disclosureVersion: string;
    readonly choice: AiChoice;
    readonly clientIp: string | null;
  },
): Promise<Result<string>> {
  const { data, error } = await db.rpc("record_ai_choice", {
    p_surface: input.surface,
    p_disclosure_version: input.disclosureVersion,
    p_choice: input.choice,
    ...(input.clientIp === null ? {} : { p_client_ip: input.clientIp }),
  });
  if (error) return fail(toDataError(error));
  return ok(String(data));
}
