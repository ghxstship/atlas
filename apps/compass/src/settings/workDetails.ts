/**
 * Work Details editing in Compass (Section 4.5.6 personal settings item 10, migration 1340, ADR 0071): uniform
 * sizes, dietary and accessibility needs, the travel profile and emergency contacts, checked by the parsers Atlas and
 * Gateway share (@xos/data/work-details-forms) and saved by the same repository functions.
 *
 * Work Details save online only and never stay on the phone: dietary and accessibility needs are health
 * information, and emergency contacts are other people's details (A65-003). The passport number needs a step-up
 * and an audited reveal, so the passport, loyalty programs, sharing with engagements and the access log open on the
 * web.
 */
import type { DataError } from "@xos/data/result";
import {
  GARMENT_LETTER_SIZES,
  type EmergencyContact,
  type WorkDetails,
} from "@xos/data/work-details";
import { workDetailErrorKey, type Parsed } from "@xos/data/work-details-forms";

/** The most emergency contacts a person keeps (emergency_contact_limit, 1340). */
export const MAX_CONTACTS = 5;

/** A form's fields by name: text, or the chosen values of a multiple choice. */
export type FieldValues = Readonly<Record<string, string | readonly string[]>>;

/**
 * The fields as the shared parsers read a submitted form (FormData's get and getAll), so Compass checks exactly what
 * Atlas and Gateway check. A field left out reads as absent, as an unsubmitted input does.
 */
export function formFields(values: FieldValues): FormData {
  const all = (name: string): string[] => {
    const value = values[name];
    if (value === undefined) return [];
    return typeof value === "string" ? [value] : [...value];
  };
  return { get: (name: string) => all(name)[0] ?? null, getAll: all } as unknown as FormData;
}

/** The list with the item added, or removed when it was there. */
export function toggled<T extends string>(list: readonly T[], item: T): T[] {
  return list.includes(item) ? list.filter((i) => i !== item) : [...list, item];
}

/** The place a new emergency contact takes in calling order: after the last one. */
export function nextSortOrder(contacts: readonly Pick<EmergencyContact, "sortOrder">[]): number {
  return contacts.length === 0 ? 0 : Math.max(...contacts.map((c) => c.sortOrder)) + 1;
}

/** Garment sizes as a choice, the first meaning not set. */
export const SIZE_CHOICES: readonly string[] = ["", ...GARMENT_LETTER_SIZES];

/** The uniform form as saved. */
export function uniformFields(d: WorkDetails | null): Record<string, string> {
  return {
    shirtSize: d?.shirtSize ?? "",
    jacketSize: d?.jacketSize ?? "",
    pantsSize: d?.pantsSize ?? "",
    shoeSize: d?.shoeSize ?? "",
    gloveSize: d?.gloveSize ?? "",
    hatSize: d?.hatSize ?? "",
    uniformNotes: d?.uniformNotes ?? "",
  };
}

/** The travel form as saved. */
export function travelFields(d: WorkDetails | null): Record<string, string> {
  return {
    seatPreference: d?.seatPreference ?? "",
    mealPreference: d?.mealPreference ?? "",
    homeAirport: d?.homeAirport ?? "",
  };
}

/** A blank emergency contact form. */
export const NEW_CONTACT: Readonly<Record<string, string>> = {
  fullName: "",
  relationship: "",
  phone: "",
  alternatePhone: "",
  email: "",
};

/** The `workDetails.errors.*` key under each field a parser rejected. */
export function fieldErrorKeys(parsed: Parsed<unknown>): Record<string, string> {
  if (parsed.ok) return {};
  return Object.fromEntries(parsed.fields.map((f) => [f, `workDetails.errors.${parsed.code}`]));
}

/** The `workDetails.errors.*` key of a refused save. */
export function saveErrorKey(error: DataError): string {
  return `workDetails.errors.${workDetailErrorKey(error)}`;
}
