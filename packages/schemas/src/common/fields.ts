/**
 * Field builders for resource schemas.
 *
 * Every builder attaches a description and an example, so the OpenAPI document can carry
 * an example for every operation without hand-written fixtures. Field names follow the
 * Section 7 table and column names (snake_case).
 */
import { z } from "zod";

/** A UUID v7 used as the example identifier throughout the contract. */
export const EXAMPLE_UUID = "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f";
export const EXAMPLE_INSTANT = "2026-10-08T14:30:00Z";
export const EXAMPLE_DATE = "2026-10-08";

/** Title Case label: canon display values and lifecycle state labels. */
export const TITLE_CASE_PATTERN = "^[A-Z0-9][A-Za-z0-9&'/.()-]*( [A-Za-z0-9&'/.()-]+)*$";

export function uuid(description: string) {
  return z.uuid().meta({ description, example: EXAMPLE_UUID });
}

/** Foreign key to another resource. */
export function ref(entity: string) {
  return uuid(`Identifier of the ${entity}.`);
}

export function instant(description: string) {
  return z.iso.datetime({ offset: true }).meta({ description, example: EXAMPLE_INSTANT });
}

export function date(description: string) {
  return z.iso.date().meta({ description, example: EXAMPLE_DATE });
}

export function text(description: string, example: string, max = 300) {
  return z.string().min(1).max(max).meta({ description, example });
}

export function longText(description: string, example: string) {
  return z.string().min(1).max(20000).meta({ description, example });
}

export function int(description: string, example: number, min = 0) {
  return z.int().min(min).meta({ description, example });
}

/** A decimal quantity, for example 2.5 hours or 12 units. */
export function quantity(description: string, example: number) {
  return z.number().meta({ description, example });
}

export function bool(description: string, example: boolean) {
  return z.boolean().meta({ description, example });
}

/**
 * Money in integer minor units (ADR 0002). NULL means unpriced and is never coerced to 0
 * (Section 3.7). Pair it with a `currency` field on the same resource.
 */
export function money(description: string, example: number) {
  return z
    .int()
    .nullable()
    .meta({
      description: `${description} Integer minor units of the resource currency; null means unpriced, never zero.`,
      example,
      format: "int64",
    });
}

export function currency(description = "ISO 4217 currency code of every money field.") {
  return z
    .string()
    .regex(/^[A-Z]{3}$/)
    .meta({ description, example: "USD" });
}

export function email(description: string) {
  return z.email().meta({ description, example: "alex.rivera@northwindlive.example" });
}

export function url(description: string) {
  return z
    .url()
    .meta({ description, example: "https://northwindlive.example/files/site-plan.pdf" });
}

export function phone(description: string) {
  return z
    .string()
    .regex(/^\+[1-9][0-9]{6,14}$/)
    .meta({ description: `${description} E.164 format.`, example: "+13055550142" });
}

export function countryCode(description = "ISO 3166-1 alpha-2 country code.") {
  return z
    .string()
    .regex(/^[A-Z]{2}$/)
    .meta({ description, example: "US" });
}

export function timeZone(description = "IANA time zone the local time was entered in.") {
  return z
    .string()
    .regex(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/)
    .meta({ description, example: "America/New_York" });
}

export function localeTag(description = "BCP 47 locale tag.") {
  return z
    .string()
    .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/)
    .meta({ description, example: "en-US" });
}

export function latitude() {
  return z.number().min(-90).max(90).meta({ description: "WGS 84 latitude.", example: 25.7617 });
}

export function longitude() {
  return z
    .number()
    .min(-180)
    .max(180)
    .meta({ description: "WGS 84 longitude.", example: -80.1918 });
}

/**
 * A lifecycle state label whose closed list lives in the database (a Postgres enum or a
 * reference table) and is not restated in the spec. Display labels come from i18n.
 */
export function stateLabel(description: string, example: string) {
  return z
    .string()
    .regex(new RegExp(TITLE_CASE_PATTERN))
    .meta({
      description: `${description} A Title Case value from the lifecycle's database enum.`,
      example,
    });
}

/** A short machine code that is ours (Section 3.6), such as a scope code or emergency code. */
export function code(description: string, example: string) {
  return z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
    .meta({ description, example });
}

/** A JSON payload, used only where ADR 0002 allows JSON: rich text, audit diffs, provider payloads. */
export function document(description: string) {
  return z.record(z.string(), z.unknown()).meta({ description, example: { type: "doc" } });
}
