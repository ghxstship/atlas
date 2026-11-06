import { todayIn } from "./calendar.ts";

/**
 * Fills an engagement document template per person (B10, ADR 0149 decision 4). Pure: the facts are read as the caller
 * (engagement-document-batches.ts), so a masked rate or an unreadable shift is missing, never merged as empty. The
 * closed field list is private.engagement_document_merge_fields (2993). Dates and money are written in the template's
 * locale; each shift is written in its own time zone; today is the project's day.
 */

export const ENGAGEMENT_DOCUMENT_MERGE_FIELDS = [
  "party.name",
  "org.name",
  "project.name",
  "project.key",
  "engagement.role",
  "engagement.opportunity",
  "engagement.start_date",
  "engagement.end_date",
  "engagement.rate",
  "engagement.pay_basis",
  "shifts.count",
  "shifts.first_call",
  "shifts.last_end",
  "shifts.total_hours",
  "shifts.table",
  "today",
] as const;

export type MergeField = (typeof ENGAGEMENT_DOCUMENT_MERGE_FIELDS)[number];

/** Fields that merge empty when the engagement has no value; every other field without a value is listed as missing. */
const OPTIONAL_FIELDS: ReadonlySet<string> = new Set(["engagement.end_date", "engagement.opportunity"]);

const FIELD_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g;

export interface MergeShift {
  readonly startsAt: string;
  readonly endsAt: string;
  /** The shift's own IANA zone, which may differ from the project's. */
  readonly timeZone: string;
  readonly jobTitle: string | null;
}

export interface MergeFacts {
  readonly partyName: string | null;
  readonly orgName: string | null;
  readonly projectName: string | null;
  readonly projectKey: string | null;
  /** The project's IANA zone: the day `today` means. */
  readonly projectTimeZone: string | null;
  readonly roleTitle: string | null;
  readonly opportunityTitle: string | null;
  /** YYYY-MM-DD. */
  readonly startDate: string | null;
  /** YYYY-MM-DD. */
  readonly endDate: string | null;
  /** Null when the rate is masked for the caller or the engagement has none. */
  readonly rate: {
    readonly minor: number;
    readonly currency: string;
    readonly exponent: number;
  } | null;
  /** The pay basis as the template's locale writes it. */
  readonly payBasis: string | null;
  /** Null when the caller may not read the project's shifts, so a text never says 0 shifts by mistake. */
  readonly shifts: readonly MergeShift[] | null;
}

export interface MergedDocument {
  readonly title: string;
  readonly body: string;
  /** The fields this person has no value for; a document with any is not created. */
  readonly missing: readonly string[];
}

/** The merge fields a template's title and body use. */
export function templateMergeFields(text: string): string[] {
  return [...new Set([...text.matchAll(FIELD_PATTERN)].map((m) => m[1] ?? ""))];
}

/** True when a template text uses the Restricted rate. */
export function usesRate(body: string): boolean {
  return templateMergeFields(body).includes("engagement.rate");
}

/** Fields a template names that are outside the closed list, as the database checks them. */
export function unknownMergeFields(text: string): string[] {
  const known: readonly string[] = ENGAGEMENT_DOCUMENT_MERGE_FIELDS;
  return templateMergeFields(text).filter((f) => !known.includes(f));
}

function dateText(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(
    new Date(`${iso}T00:00:00Z`),
  );
}

function instantText(iso: string, timeZone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "long",
    timeStyle: "short",
    timeZone,
  }).format(new Date(iso));
}

function moneyText(rate: NonNullable<MergeFacts["rate"]>, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: rate.currency,
    minimumFractionDigits: rate.exponent,
    maximumFractionDigits: rate.exponent,
  }).format(rate.minor / 10 ** rate.exponent);
}

function shiftLine(shift: MergeShift, locale: string): string {
  const range = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: shift.timeZone,
    timeZoneName: "short",
  }).formatRange(new Date(shift.startsAt), new Date(shift.endsAt));
  return shift.jobTitle ? `${range}, ${shift.jobTitle}` : range;
}

function fieldValue(field: string, facts: MergeFacts, locale: string, now: Date): string | null {
  const shifts = facts.shifts === null ? null : [...facts.shifts].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const hours = (list: readonly MergeShift[]) =>
    list.reduce((sum, s) => sum + (Date.parse(s.endsAt) - Date.parse(s.startsAt)) / 3_600_000, 0);
  switch (field) {
    case "party.name":
      return facts.partyName;
    case "org.name":
      return facts.orgName;
    case "project.name":
      return facts.projectName;
    case "project.key":
      return facts.projectKey;
    case "engagement.role":
      return facts.roleTitle;
    case "engagement.opportunity":
      return facts.opportunityTitle;
    case "engagement.start_date":
      return facts.startDate ? dateText(facts.startDate, locale) : null;
    case "engagement.end_date":
      return facts.endDate ? dateText(facts.endDate, locale) : null;
    case "engagement.rate":
      return facts.rate ? moneyText(facts.rate, locale) : null;
    case "engagement.pay_basis":
      return facts.payBasis;
    case "shifts.count":
      return shifts === null ? null : new Intl.NumberFormat(locale).format(shifts.length);
    case "shifts.first_call": {
      const first = shifts?.[0];
      return first ? instantText(first.startsAt, first.timeZone, locale) : null;
    }
    case "shifts.last_end": {
      if (!shifts || shifts.length === 0) return null;
      const last = [...shifts].sort((a, b) => a.endsAt.localeCompare(b.endsAt)).at(-1);
      return last ? instantText(last.endsAt, last.timeZone, locale) : null;
    }
    case "shifts.total_hours":
      return shifts === null
        ? null
        : new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(hours(shifts));
    case "shifts.table":
      return shifts && shifts.length > 0 ? shifts.map((s) => shiftLine(s, locale)).join("\n") : null;
    case "today":
      return facts.projectTimeZone ? dateText(todayIn(facts.projectTimeZone, now), locale) : null;
    default:
      return null;
  }
}

/**
 * Merges a template for one person. Optional fields merge empty; a required field with no value stays in the text and is
 * listed in `missing`, so the database refuses the text if it is ever sent.
 */
export function mergeEngagementDocument(
  template: { readonly title: string; readonly body: string },
  facts: MergeFacts,
  locale: string,
  now: Date = new Date(),
): MergedDocument {
  const missing = new Set<string>();
  const fill = (text: string) =>
    text.replace(FIELD_PATTERN, (whole, name: string) => {
      const value = fieldValue(name, facts, locale, now);
      if (value !== null && value !== "") return value;
      if (OPTIONAL_FIELDS.has(name)) return "";
      missing.add(name);
      return whole;
    });
  const title = fill(template.title).trim();
  const body = fill(template.body);
  return { title, body, missing: [...missing].sort() };
}
