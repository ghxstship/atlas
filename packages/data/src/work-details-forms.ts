import type { DataError } from "./result.ts";
import {
  ACCESSIBILITY_NEEDS,
  DIETARY_NEEDS,
  LOYALTY_PROGRAM_KINDS,
  SHAREABLE_WORK_DETAIL_CATEGORIES,
  WORK_DETAIL_RULES,
  type EmergencyContactInput,
  type LoyaltyProgramInput,
  type WorkDetailCategory,
  type WorkDetailsPatch,
} from "./work-details.ts";

/**
 * The Work Details forms of Atlas and Gateway read the same fields, so their server actions share
 * these parsers: each turns a submitted FormData into the repository input, or names the fields to
 * fix (`invalid`, or `phone` for a number that is not a phone number). Blank text clears a value.
 * Errors map to `workDetails.errors.*` keys with `workDetailErrorKey`.
 */

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly fields: readonly string[]; readonly code: "invalid" | "phone" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const good = <T>(value: T): Parsed<T> => ({ ok: true, value });
const bad = <T>(fields: readonly string[], code: "invalid" | "phone" = "invalid"): Parsed<T> => ({
  ok: false,
  fields,
  code,
});

/** Trimmed text: null when blank, undefined when absent or longer than `max`. */
function text(form: FormData, name: string, max: number): string | null | undefined {
  const value = form.get(name);
  if (value === null) return undefined;
  const trimmed = String(value).trim();
  if (trimmed === "") return null;
  return trimmed.length > max ? undefined : trimmed;
}

/** Optional text: blank or absent is null; too long is a problem. */
function optional(form: FormData, name: string, max: number, problems: string[]): string | null {
  const value = text(form, name, max);
  if (value === undefined && form.get(name) !== null) problems.push(name);
  return value ?? null;
}

function pick<T extends string>(allowed: readonly T[], value: unknown): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function pickAll<T extends string>(allowed: readonly T[], form: FormData, name: string): T[] {
  return form
    .getAll(name)
    .filter((v): v is T => typeof v === "string" && (allowed as readonly string[]).includes(v));
}

export function parseDietaryForm(form: FormData): Parsed<WorkDetailsPatch> {
  const problems: string[] = [];
  const value: WorkDetailsPatch = {
    dietaryNeeds: pickAll(DIETARY_NEEDS, form, "dietaryNeeds"),
    allergies: optional(form, "allergies", 500, problems),
    dietaryNotes: optional(form, "dietaryNotes", 500, problems),
  };
  return problems.length > 0 ? bad(problems) : good(value);
}

export function parseAccessibilityForm(form: FormData): Parsed<WorkDetailsPatch> {
  const problems: string[] = [];
  const value: WorkDetailsPatch = {
    accessibilityNeeds: pickAll(ACCESSIBILITY_NEEDS, form, "accessibilityNeeds"),
    accessibilityNotes: optional(form, "accessibilityNotes", 1000, problems),
  };
  return problems.length > 0 ? bad(problems) : good(value);
}

/** Passport details; `number` is null when the field was left blank (keep the number on file). */
export function parsePassportForm(
  form: FormData,
): Parsed<{ readonly patch: WorkDetailsPatch; readonly number: string | null }> {
  const problems: string[] = [];
  const country = optional(form, "passportIssuingCountry", 2, problems)?.toUpperCase() ?? null;
  const expires = optional(form, "passportExpiresOn", 10, problems);
  const name = optional(form, "passportName", 200, problems);
  const number = optional(form, "passportNumber", 40, problems);
  if (country !== null && !/^[A-Z]{2}$/.test(country)) problems.push("passportIssuingCountry");
  if (expires !== null && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) problems.push("passportExpiresOn");
  if (problems.length > 0) return bad(problems);
  return good({
    patch: { passportIssuingCountry: country, passportExpiresOn: expires, passportName: name },
    number,
  });
}

/** An emergency contact; `toE164` reads typed phones (the app passes the viewer's region). */
export function parseContactForm(
  form: FormData,
  toE164: (input: string) => string | null,
): Parsed<EmergencyContactInput> {
  const problems: string[] = [];
  const fullName = text(form, "fullName", 200);
  if (!fullName) problems.push("fullName");
  const relationship = optional(form, "relationship", 60, problems);
  const email = optional(form, "email", 320, problems);
  if (email !== null && !EMAIL.test(email)) problems.push("email");
  if (problems.length > 0) return bad(problems);
  const phone = toE164(String(form.get("phone") ?? ""));
  const alternateRaw = text(form, "alternatePhone", 40) ?? null;
  const alternate = alternateRaw === null ? null : toE164(alternateRaw);
  const phoneProblems = [
    ...(phone ? [] : ["phone"]),
    ...(alternateRaw !== null && !alternate ? ["alternatePhone"] : []),
  ];
  if (phoneProblems.length > 0 || !fullName || !phone) return bad(phoneProblems, "phone");
  const order = Number(form.get("sortOrder") ?? 0);
  return good({
    fullName,
    relationship,
    phoneE164: phone,
    alternatePhoneE164: alternate,
    email,
    sortOrder: Number.isInteger(order) && order >= 0 && order <= 99 ? order : 0,
  });
}

export function parseLoyaltyForm(form: FormData): Parsed<LoyaltyProgramInput> {
  const programKind = pick(LOYALTY_PROGRAM_KINDS, form.get("programKind"));
  const programName = text(form, "programName", 100);
  const memberNumber = text(form, "memberNumber", 40);
  if (!programKind || !programName || !memberNumber) {
    return bad([
      ...(!programKind ? ["programKind"] : []),
      ...(!programName ? ["programName"] : []),
      ...(!memberNumber ? ["memberNumber"] : []),
    ]);
  }
  return good({ programKind, programName, memberNumber });
}

/** A row id from a hidden field. */
export function parseId(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === "string" && UUID.test(value) ? value : null;
}

export function parseShareForm(
  form: FormData,
): Parsed<{ readonly engagementId: string; readonly categories: WorkDetailCategory[] }> {
  const engagementId = parseId(form, "engagementId");
  // Uniform Sizes is retired (R6a): sizes are entered per roster entry, so a share never names it.
  const categories = pickAll(SHAREABLE_WORK_DETAIL_CATEGORIES, form, "categories");
  if (!engagementId) return bad(["engagementId"]);
  if (categories.length === 0) return bad(["categories"]);
  return good({ engagementId, categories });
}

export function parseNamePartsForm(
  form: FormData,
): Parsed<{ readonly givenName: string | null; readonly familyName: string | null }> {
  const problems: string[] = [];
  const givenName = optional(form, "givenName", 100, problems);
  const familyName = optional(form, "familyName", 100, problems);
  return problems.length > 0 ? bad(problems) : good({ givenName, familyName });
}

const RULES: ReadonlySet<string> = new Set(WORK_DETAIL_RULES);

/** The `workDetails.errors.*` key for a repository error. */
export function workDetailErrorKey(error: DataError): string {
  if (error.kind === "refusal") return RULES.has(error.rule) ? error.rule : "unexpected";
  if (error.kind === "not-found") return "denied";
  if (error.kind === "conflict") return "conflict";
  if (error.kind === "invalid") return "invalid";
  return "unexpected";
}
