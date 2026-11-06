import { z } from "zod";
import { zonedInstant } from "../lists.ts";
import type { DocumentContent } from "../model.ts";
import {
  runFeature,
  type AuroraContext,
  type AuroraResult,
  type ProposedChange,
  type ProposedField,
  type Subject,
  FeatureError,
} from "../session.ts";
import { withholdIdentity } from "../redact.ts";
import { inferYear, isAreaTimeZone, tieOut, type TieOutResult } from "../intake.ts";
import { callTool, dataBlock, GUARDRAILS } from "./shared.ts";

/**
 * Document extraction (Section 4.7): riders, insurance certificates, invoices, receipts, quotes,
 * itineraries and contracts become proposed fields with a confidence each and provenance agent.
 * Nothing is written until the person confirms. A price, date or quantity the document does not show
 * word for word becomes NO_ANSWER, whatever the model said (Section 3.7).
 *
 * B15: an itinerary proposes one travel segment per passenger and segment, a contract or rider one
 * booking document whose fee is Restricted (ADR 0154 D2), and an invoice its lines, with the tie-out
 * computed in code. Itinerary and invoice lines use a compact schema, one excerpt and confidence per
 * line, because the extraction token limit fits only about 7 lines in the per-field shape.
 */

export const DOCUMENT_KINDS = [
  "rider",
  "insurance_certificate",
  "invoice",
  "receipt",
  "quote",
  "itinerary",
  "contract",
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/**
 * Field kinds. `money`, `date`, `quantity` and `local_datetime` must be read from the source, never
 * inferred. `local_datetime` is a wall-clock time on a day, YYYY-MM-DDTHH:MM, in no zone. A
 * `time_zone` is validated but not strict, because itineraries print local times without zones.
 */
export type FieldKind =
  "text" | "date" | "money" | "quantity" | "currency" | "local_datetime" | "time_zone";

export interface ExtractionField {
  readonly path: string;
  readonly kind: FieldKind;
  readonly description: string;
}

export interface ExtractionTarget {
  /** Public API operation the header fields feed. */
  readonly operationId: string;
  readonly fields: readonly ExtractionField[];
  /** Repeating lines (quote lines, rider lines), each proposed as its own change. */
  readonly lines?: {
    readonly operationId: string;
    readonly fields: readonly ExtractionField[];
  };
}

/** Targets follow the OpenAPI v1 create schemas; ids such as document_id come from the caller. */
export const EXTRACTION_TARGETS: Readonly<Record<DocumentKind, ExtractionTarget>> = {
  // Field paths follow the corrected insuranceCertificates.create body (the API catalog's Vendors
  // correction); the insured vendor_id comes from the person when they confirm.
  insurance_certificate: {
    operationId: "insuranceCertificates.create",
    fields: [
      { path: "insurer", kind: "text", description: "Insurer as printed, for example Insurer A." },
      { path: "policy_identifier", kind: "text", description: "Policy number as printed." },
      {
        path: "coverage_type",
        kind: "text",
        description: "Coverage type, for example General Liability.",
      },
      {
        path: "coverage_limit_minor",
        kind: "money",
        description: "Each occurrence limit in minor units.",
      },
      { path: "currency_code", kind: "currency", description: "ISO 4217 currency of the limit." },
      { path: "valid_from", kind: "date", description: "Policy effective date, YYYY-MM-DD." },
      { path: "valid_to", kind: "date", description: "Policy expiry date, YYYY-MM-DD." },
    ],
    // Each party the certificate names (finding A38-001); confirmed with the certificate's id.
    lines: {
      operationId: "insuranceCertificateInsureds.create",
      fields: [
        {
          path: "insured_name",
          kind: "text",
          description: "A party named as additional insured or certificate holder, as printed.",
        },
        {
          path: "endorsement_kind",
          kind: "text",
          description:
            "Exactly one of Additional Insured, Primary and Noncontributory, Waiver of Subrogation.",
        },
      ],
    },
  },
  // The invoice, expense and RFQ response forms in Atlas fill from these (A95); the project,
  // counterparty, budget line and vendor come from the person, never from the document. The lines
  // stay open for the invoice's detail after the form is saved.
  invoice: {
    operationId: "invoices.create",
    fields: [
      { path: "invoice_number", kind: "text", description: "Invoice number as printed." },
      { path: "issued_on", kind: "date", description: "Issue date, YYYY-MM-DD." },
      { path: "due_on", kind: "date", description: "Due date, YYYY-MM-DD." },
      { path: "currency_code", kind: "currency", description: "ISO 4217 currency." },
      {
        path: "printed_total_minor",
        kind: "money",
        description: "The total the document prints, in minor units.",
      },
    ],
    lines: {
      operationId: "invoiceLines.create",
      fields: [
        { path: "description", kind: "text", description: "Line description." },
        { path: "quantity", kind: "quantity", description: "Quantity billed." },
        { path: "unit_price_minor", kind: "money", description: "Unit price in minor units." },
      ],
    },
  },
  // The expense is the printed total; a receipt's items and tax stay in the answer, not the proposal,
  // because app.expenses has no lines and Compass reads the header.
  receipt: {
    operationId: "expenses.create",
    fields: [
      { path: "description", kind: "text", description: "What was bought, in a short phrase." },
      { path: "amount_minor", kind: "money", description: "Total paid in minor units." },
      { path: "currency_code", kind: "currency", description: "ISO 4217 currency." },
      { path: "incurred_on", kind: "date", description: "Purchase date, YYYY-MM-DD." },
    ],
  },
  // A vendor's quote answers an RFQ, so it becomes an RFQ response with its quoted lines.
  quote: {
    operationId: "rfqResponses.create",
    fields: [
      {
        path: "valid_until",
        kind: "date",
        description: "Date the quote is valid until, YYYY-MM-DD.",
      },
      { path: "currency_code", kind: "currency", description: "ISO 4217 currency of the prices." },
    ],
    lines: {
      operationId: "rfqResponseLines.create",
      fields: [
        { path: "description", kind: "text", description: "Line description." },
        { path: "quantity", kind: "quantity", description: "Quantity quoted." },
        { path: "unit_price_minor", kind: "money", description: "Unit price in minor units." },
        { path: "currency_code", kind: "currency", description: "ISO 4217 currency." },
      ],
    },
  },
  rider: {
    operationId: "riders.create",
    fields: [
      { path: "title", kind: "text", description: "Rider title, for example Technical Rider." },
    ],
    lines: {
      operationId: "riderLines.create",
      fields: [
        { path: "description", kind: "text", description: "The ask as the rider states it." },
        { path: "quantity", kind: "quantity", description: "Quantity required, if stated." },
      ],
    },
  },
  // Applied only by app.apply_itinerary_lines: this operation names no API handler (ADR 0154 D5).
  itinerary: {
    operationId: "travelSegments.create",
    fields: [],
    lines: { operationId: "travelSegments.create", fields: [] },
  },
  // Applied only by app.apply_contract_intake. The party, role and terms come from the person. The
  // fee fields join for a payroll reader only (CONTRACT_FEE_FIELDS). Deposits, splits, payment
  // schedules and ticket shares are never read: XOS does not hold funds.
  contract: {
    operationId: "engagements.createFromContract",
    fields: [
      {
        path: "document_type",
        kind: "text",
        description: "Exactly one of Contract, Rider or Other.",
      },
      { path: "title", kind: "text", description: "The document's title as printed." },
      { path: "act_name", kind: "text", description: "The act or artist booked, as printed." },
      { path: "start_date", kind: "date", description: "First date of the engagement, YYYY-MM-DD." },
      { path: "end_date", kind: "date", description: "Last date of the engagement, YYYY-MM-DD." },
    ],
  },
};

/** Asked of the model only for a holder of data.restricted.read.payroll (ADR 0154 D2). */
export const CONTRACT_FEE_FIELDS: readonly ExtractionField[] = [
  {
    path: "agreed_rate_minor",
    kind: "money",
    description: "The guaranteed fee in minor units. Never a deposit, split or ticket share.",
  },
  {
    path: "agreed_rate_currency_code",
    kind: "currency",
    description: "ISO 4217 currency of the fee.",
  },
];

/** The most lines one document proposes, after passengers are expanded. */
export const MAX_DOCUMENT_LINES = 40;

const FieldValue = z.object({
  field_path: z.string().min(1),
  value: z.union([z.string(), z.number(), z.null()]),
  confidence: z.number().min(0).max(1).nullable(),
  source_excerpt: z.string().max(2000).nullable(),
  missing: z.string().max(500).nullable(),
});

const ExtractionSchema = z.object({
  fields: z.array(FieldValue),
  lines: z.array(z.object({ fields: z.array(FieldValue) })).default([]),
});
type RawField = z.infer<typeof FieldValue>;

/** One line of the compact schema: one excerpt, one confidence and what is missing, per line. */
const CompactLine = {
  source_excerpt: z.string().max(2000).nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  missing: z.array(z.string().max(120)).default([]),
};

const ItinerarySchema = z.object({
  segments: z.array(
    z.object({
      passengers: z.array(
        z.object({
          name: z.string().max(200),
          price_minor: z.number().nullable().optional(),
          currency_code: z.string().nullable().optional(),
          price_excerpt: z.string().max(500).nullable().optional(),
        }),
      ),
      travel_mode: z.string().nullable(),
      operator_name: z.string().nullable(),
      service_identifier: z.string().nullable(),
      confirmation_identifier: z.string().nullable(),
      departs_from: z.string().nullable(),
      arrives_at_place: z.string().nullable(),
      departs_local: z.string().nullable(),
      arrives_local: z.string().nullable(),
      departs_time_zone: z.string().nullable(),
      arrives_time_zone: z.string().nullable(),
      ...CompactLine,
    }),
  ),
});

const AmountLine = z.object({
  description: z.string().nullable(),
  quantity: z.number().nullable(),
  /** An invoice line's unit price, or a receipt line's amount. */
  price_minor: z.number().nullable(),
  ...CompactLine,
});

/** Invoice and receipt: per-field header, compact lines, and printed values read for the tie-out. */
const AmountsSchema = z.object({
  fields: z.array(FieldValue),
  read: z.array(FieldValue).default([]),
  lines: z.array(AmountLine).default([]),
});

const STRICT_KINDS: ReadonlySet<FieldKind> = new Set([
  "money",
  "date",
  "quantity",
  "local_datetime",
]);

function digits(value: string): string {
  return value.replace(/[^0-9]/g, "");
}

/** Quantities a document may spell out. Index is the number. */
const NUMBER_WORDS: readonly string[] = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The time of a local datetime as an excerpt may print it: 08:15, 8:15, 8:15 am or 0815. */
function showsTime(hh: string, mm: string, text: string): boolean {
  const h = Number(hh);
  const twelve = ((h + 11) % 12) + 1;
  const meridiem = h < 12 ? "a" : "p";
  return (
    new RegExp(`(^|[^0-9])(${hh}|${h}):${mm}([^0-9]|$)`).test(text) ||
    new RegExp(`(^|[^0-9])${twelve}:${mm}\\s*${meridiem}\\.?m\\b`).test(text) ||
    new RegExp(`(^|[^0-9:])${hh}${mm}([^0-9]|$)`).test(text)
  );
}

/** The month and day as an excerpt may print them without a year. */
function showsMonthDay(m: string, d: string, text: string): boolean {
  const month = MONTHS[Number(m) - 1] ?? "";
  const day = String(Number(d));
  return (
    new RegExp(`(^|[^0-9])0?${day}(st|nd|rd|th)?\\s*${month}`).test(text) ||
    new RegExp(`\\b${month}[a-z]*\\.?\\s*0?${day}(st|nd|rd|th)?([^0-9]|$)`).test(text) ||
    new RegExp(`(^|[^0-9])0?${Number(m)}/0?${day}([^0-9]|$)`).test(text)
  );
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** A local date and time read from its excerpt, with the year it was given. */
export interface LocalReading {
  /** YYYY-MM-DDTHH:MM. */
  readonly value: string;
  readonly yearInferred: boolean;
}

/**
 * Reads a local datetime against its word-for-word excerpt: the month, day and time must be shown.
 * A year the excerpt does not print is never the model's: it is the first such date on or after
 * `notBefore` (`inferYear`), the project's today for a departure and the departure's day for an
 * arrival. An arrival printed with +1 or +2 counts from the departure. Otherwise null.
 */
export function readLocalDateTime(
  value: string,
  excerpt: string,
  notBefore: string,
  departsLocal: string | null = null,
): LocalReading | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  const [, y, m, d, hh, mm] = match as unknown as [string, string, string, string, string, string];
  const text = excerpt.toLowerCase();
  if (!showsTime(hh, mm, text)) return null;
  const day = `${y}-${m}-${d}`;
  if (excerptSupports("date", day, excerpt)) return { value, yearInferred: false };
  if (showsMonthDay(m, d, text)) {
    const inferred = inferYear(Number(m), Number(d), notBefore);
    return inferred ? { value: `${inferred}T${hh}:${mm}`, yearInferred: true } : null;
  }
  const offset = /\+\s?([12])\b/.exec(text);
  const departs = departsLocal?.slice(0, 10);
  if (offset && departs && addDays(departs, Number(offset[1])) === day) {
    return { value, yearInferred: false };
  }
  return null;
}

/** True when the excerpt visibly carries the value, so it was read, not inferred. */
export function excerptSupports(kind: FieldKind, value: string | number, excerpt: string): boolean {
  const text = excerpt.toLowerCase();
  if (kind === "date") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
    if (!match) return false;
    const [, y, m, d] = match as unknown as [string, string, string, string];
    const day = String(Number(d));
    const month = MONTHS[Number(m) - 1] ?? "";
    const numeric = [
      `${y}-${m}-${d}`,
      `${Number(m)}/${day}/${y}`,
      `${m}/${d}/${y}`,
      `${d}.${m}.${y}`,
    ];
    return (
      numeric.some((form) => text.includes(form)) ||
      (text.includes(y) && text.includes(month) && new RegExp(`\\b0?${day}\\b`).test(text))
    );
  }
  if (kind === "money") {
    const minor = digits(String(value));
    if (minor === "") return false;
    const whole = String(Math.trunc(Number(value) / 100));
    const excerptDigits = digits(text);
    return excerptDigits.includes(minor) || excerptDigits.includes(whole);
  }
  if (kind === "quantity") {
    const word = NUMBER_WORDS[Number(value)];
    return (
      new RegExp(`(^|[^0-9.])${String(value).replace(".", "\\.")}([^0-9]|$)`).test(text) ||
      (word !== undefined && new RegExp(`\\b${word}\\b`).test(text))
    );
  }
  return true;
}

export interface SettleOptions {
  /** The sentence a NO_ANSWER carries, instead of the model's: a contract never stores model text. */
  readonly fixedMissing?: string;
}

/** Applies the silence rule to one field. Unknown paths are dropped; unsupported values refuse. */
export function settleField(
  spec: ExtractionField,
  raw: RawField | undefined,
  options: SettleOptions = {},
): ProposedField {
  const refuse = (missing: string): ProposedField => ({
    field_path: spec.path,
    refusal: "NO_ANSWER",
    missing: options.fixedMissing ?? missing,
  });
  if (!raw || raw.value === null || raw.value === "") {
    return refuse(raw?.missing ?? `The document does not state ${spec.description.toLowerCase()}`);
  }
  if (STRICT_KINDS.has(spec.kind)) {
    if (!raw.source_excerpt || !excerptSupports(spec.kind, raw.value, raw.source_excerpt)) {
      return refuse("The document does not show this value, so it was not guessed.");
    }
  }
  if (spec.kind === "money" && !Number.isInteger(Number(raw.value))) {
    return refuse("The amount could not be read as a whole number of minor units.");
  }
  if (spec.kind === "currency" && !/^[A-Z]{3}$/.test(String(raw.value))) {
    return refuse("The document does not name an ISO 4217 currency.");
  }
  if (spec.kind === "time_zone" && !isAreaTimeZone(String(raw.value))) {
    return refuse("No valid IANA time zone could be read for this place.");
  }
  return {
    field_path: spec.path,
    value: spec.kind === "money" || spec.kind === "quantity" ? Number(raw.value) : raw.value,
    confidence: raw.confidence ?? 0,
    ...(raw.source_excerpt ? { source_excerpt: withholdIdentity(raw.source_excerpt) } : {}),
  };
}

function settle(
  fields: readonly ExtractionField[],
  raw: readonly RawField[],
  options: SettleOptions = {},
): ProposedField[] {
  const byPath = new Map(raw.map((f) => [f.field_path, f]));
  return fields.map((spec) => settleField(spec, byPath.get(spec.path), options));
}

function fieldList(fields: readonly ExtractionField[]): string {
  return fields.map((f) => `- ${f.path} (${f.kind}): ${f.description}`).join("\n");
}

// Money in a contract's other fields --------------------------------------------------------------

const CURRENCY_CODES =
  "USD|EUR|GBP|CAD|AUD|NZD|MXN|JPY|CHF|SEK|NOK|DKK|BRL|ZAR|INR|CNY|HKD|SGD|AED|ARS|CLP|COP|PEN";
/** A date in a form with separators, removed first so 05.06.2027 is not read as an amount. */
const DATE_FORM = /\b(?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}-\d{2}-\d{2})\b/g;
const MONEY_PATTERNS: readonly RegExp[] = [
  // A currency sign or code beside digits, on either side.
  new RegExp(`[$€£¥]\\s?\\d|\\d\\s?[$€£¥]|\\b(?:${CURRENCY_CODES})\\s?\\d|\\d\\s?(?:${CURRENCY_CODES})\\b`, "i"),
  // Digits with thousands separators, or decimals as an amount prints them.
  /\b\d{1,3}(?:[,.\s]\d{3})+\b|\b\d+[.,]\d{2}\b/,
  // An amount in words.
  /\b(?:hundred|thousand|million|dollars?|euros?|pounds?|cents?)\b/i,
  // A pay word beside a number of three digits or more.
  /\b(?:fee|guarantee|deposit|compensation|payment|pay|rate)\b[^.\n]{0,40}\b\d{3,}\b/i,
];

/** True when a text carries a money amount, so a contract's other fields never expose a fee. */
export function containsMoney(text: string): boolean {
  const withoutDates = text.replace(DATE_FORM, " ");
  return MONEY_PATTERNS.some((pattern) => pattern.test(withoutDates));
}

/** What a contract's field says when it is left unread. Never the model's words (ADR 0154 D2). */
export const CONTRACT_MISSING = "The document does not show this value, so it was not read.";
const CONTRACT_TYPES = ["Contract", "Rider", "Other"];

function settleContract(
  raw: readonly RawField[],
  feeVisible: boolean,
): ProposedField[] {
  const fee = new Set(CONTRACT_FEE_FIELDS.map((f) => f.path));
  const specs = [...EXTRACTION_TARGETS.contract.fields, ...(feeVisible ? CONTRACT_FEE_FIELDS : [])];
  return settle(specs, raw, { fixedMissing: CONTRACT_MISSING }).map((field) => {
    const unread: ProposedField = {
      field_path: field.field_path,
      refusal: "NO_ANSWER",
      missing: CONTRACT_MISSING,
    };
    if (field.refusal !== undefined) return unread;
    if (field.field_path === "document_type" && !CONTRACT_TYPES.includes(String(field.value))) {
      return unread;
    }
    if (fee.has(field.field_path)) return field;
    const shown = `${String(field.value)}\n${field.source_excerpt ?? ""}`;
    return containsMoney(shown) ? unread : field;
  });
}

// Itinerary lines -----------------------------------------------------------------------------------

export type ExtractionDropReason = "length" | "zone" | "time" | "too_many";

const UNREAD_TIME = "The document does not show this date and time, so it was not guessed.";
const UNREAD_VALUE = "The document does not show this value, so it was not guessed.";
const UNREAD_PRICE = "No price is printed for this passenger and segment, so none was split or guessed.";

const refused = (path: string, missing: string): ProposedField => ({
  field_path: path,
  refusal: "NO_ANSWER",
  missing,
});

/** A name's words, to check a fare was printed for this passenger. */
function namesPassenger(name: string, excerpt: string): boolean {
  const fold = (text: string) =>
    text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const folded = fold(excerpt);
  return fold(name)
    .split(/[^a-z0-9]+/)
    .filter((p) => p.length > 1 && !["mr", "mrs", "ms", "dr"].includes(p))
    .some((p) => new RegExp(`\\b${p}\\b`).test(folded));
}

interface ItineraryRead {
  readonly proposals: ProposedChange[];
  readonly dropped: { line: number; reason: ExtractionDropReason }[];
  readonly tooMany: number;
}

function readItinerary(raw: z.infer<typeof ItinerarySchema>, today: string): ItineraryRead {
  const proposals: ProposedChange[] = [];
  const dropped: { line: number; reason: ExtractionDropReason }[] = [];
  let line = 0;
  let tooMany = 0;
  for (const segment of raw.segments) {
    const passengers = segment.passengers.length > 0 ? segment.passengers : [null];
    for (const passenger of passengers) {
      line += 1;
      if (proposals.length >= MAX_DOCUMENT_LINES) {
        tooMany += 1;
        continue;
      }
      const drop = (reason: ExtractionDropReason) => dropped.push({ line, reason });
      const excerpt = withholdIdentity(segment.source_excerpt ?? "");
      const confidence = segment.confidence ?? 0;
      const text = (path: string, value: string | null, max: number): ProposedField | "broken" => {
        const v = value?.trim() ?? "";
        if (v === "") return refused(path, UNREAD_VALUE);
        if (v.length > max) return "broken";
        return { field_path: path, value: v, confidence, ...(excerpt ? { source_excerpt: excerpt } : {}) };
      };
      const operator = text("operator_name", segment.operator_name, 120);
      const service = text("service_identifier", segment.service_identifier, 40);
      const confirmation = text("confirmation_identifier", segment.confirmation_identifier, 40);
      const from = text("departs_from", segment.departs_from, 200);
      const to = text("arrives_at_place", segment.arrives_at_place, 200);
      if (
        operator === "broken" ||
        service === "broken" ||
        confirmation === "broken" ||
        from === "broken" ||
        to === "broken"
      ) {
        drop("length");
        continue;
      }
      const zone = (path: string, value: string | null): ProposedField | "broken" => {
        if (!value?.trim()) return refused(path, "The document does not show this zone.");
        if (!isAreaTimeZone(value.trim())) return "broken";
        // A zone is inferred from the place, so it is never trusted past one half.
        return { field_path: path, value: value.trim(), confidence: Math.min(confidence, 0.5) };
      };
      const departsZone = zone("departs_time_zone", segment.departs_time_zone);
      const arrivesZone = zone("arrives_time_zone", segment.arrives_time_zone);
      if (departsZone === "broken" || arrivesZone === "broken") {
        drop("zone");
        continue;
      }
      const departs = segment.departs_local
        ? readLocalDateTime(segment.departs_local, excerpt, today)
        : null;
      const arrives = segment.arrives_local
        ? readLocalDateTime(
            segment.arrives_local,
            excerpt,
            departs ? departs.value.slice(0, 10) : today,
            departs?.value ?? null,
          )
        : null;
      const instant = (reading: LocalReading | null, z: ProposedField) =>
        reading && z.refusal === undefined
          ? zonedInstant(reading.value.slice(0, 10), reading.value.slice(11), String(z.value))
          : null;
      const departsAt = instant(departs, departsZone);
      const arrivesAt = instant(arrives, arrivesZone);
      if (departsAt && arrivesAt && Date.parse(arrivesAt) < Date.parse(departsAt)) {
        drop("time");
        continue;
      }
      const mode = segment.travel_mode?.trim().toLowerCase();
      const name = passenger?.name?.trim() ?? "";
      const priced =
        passenger &&
        typeof passenger.price_minor === "number" &&
        Number.isInteger(passenger.price_minor) &&
        passenger.price_minor >= 0 &&
        /^[A-Z]{3}$/.test(passenger.currency_code ?? "") &&
        passenger.price_excerpt &&
        excerptSupports("money", passenger.price_minor, passenger.price_excerpt) &&
        namesPassenger(name, passenger.price_excerpt);
      const local = (path: string, reading: LocalReading | null): ProposedField =>
        reading
          ? { field_path: path, value: reading.value, confidence, source_excerpt: excerpt }
          : refused(path, UNREAD_TIME);
      const at = (path: string, value: string | null): ProposedField =>
        value
          ? { field_path: path, value, confidence: Math.min(confidence, 0.5) }
          : refused(path, UNREAD_TIME);
      const fields: ProposedField[] = [
        name
          ? { field_path: "passenger_name", value: name, confidence, ...(excerpt ? { source_excerpt: excerpt } : {}) }
          : refused("passenger_name", "The document does not name this passenger."),
        mode === "flight" || mode === "ground"
          ? {
              field_path: "travel_mode",
              value: mode === "flight" ? "Flight" : "Ground",
              confidence,
            }
          : refused("travel_mode", "The travel mode is Flight or Ground; the document shows neither."),
        operator,
        service,
        confirmation,
        from,
        local("departs_local", departs),
        departsZone,
        at("departs_at", departsAt),
        to,
        local("arrives_local", arrives),
        arrivesZone,
        at("arrives_at", arrivesAt),
        priced && passenger
          ? {
              field_path: "price_minor",
              value: passenger.price_minor,
              confidence,
              source_excerpt: withholdIdentity(passenger.price_excerpt ?? ""),
            }
          : refused("price_minor", UNREAD_PRICE),
        priced && passenger
          ? { field_path: "currency_code", value: passenger.currency_code, confidence }
          : refused("currency_code", UNREAD_PRICE),
        ...(departs?.yearInferred || arrives?.yearInferred
          ? [{ field_path: "year_inferred", value: true, confidence: 1 }]
          : []),
      ];
      proposals.push({
        operationId: "travelSegments.create",
        targetId: null,
        summary: `Add segment ${proposals.length + 1} from the itinerary.`,
        fields,
      });
    }
  }
  return { proposals, dropped, tooMany };
}

// Invoice and receipt -------------------------------------------------------------------------------

/** A value read for the answer, never proposed: a vendor name, a printed subtotal or tax (ADR 0051 item 6). */
export interface ReadValue {
  readonly value: string | number;
  readonly source_excerpt: string | null;
}

const READ_FIELDS: readonly ExtractionField[] = [
  { path: "vendor_name", kind: "text", description: "The vendor's name as printed." },
  {
    path: "printed_subtotal_minor",
    kind: "money",
    description: "The subtotal the document prints, in minor units.",
  },
  {
    path: "printed_tax_minor",
    kind: "money",
    description: "The tax the document prints, in minor units.",
  },
];

function readValues(raw: readonly RawField[]): Record<string, ReadValue | null> {
  return Object.fromEntries(
    settle(READ_FIELDS, raw).map((f) => [
      f.field_path,
      f.refusal === undefined
        ? { value: f.value as string | number, source_excerpt: f.source_excerpt ?? null }
        : null,
    ]),
  );
}

/** A receipt's line, in the answer only: app.expenses has no lines. */
export interface ReceiptLineItem {
  readonly description: string | null;
  readonly quantity: number | null;
  readonly amount_minor: number | null;
  readonly source_excerpt: string | null;
}

const minorOf = (read: ReadValue | null | undefined) =>
  typeof read?.value === "number" && Number.isInteger(read.value) ? read.value : null;

const proposedMinor = (fields: readonly ProposedField[], path: string): number | null => {
  const field = fields.find((f) => f.field_path === path);
  return field?.refusal === undefined && typeof field?.value === "number" ? field.value : null;
};

// The feature ---------------------------------------------------------------------------------------

export interface ExtractionInput {
  readonly kind: DocumentKind;
  readonly document: DocumentContent;
  readonly fileName: string;
  /** The stored document row or, for an intake, the project (ADR 0154 D3), so the request log names it. */
  readonly subject: Subject | null;
  /** A contract: whether the caller reads pay, from app.aurora_intake_scope and never a client flag. */
  readonly feeVisible?: boolean;
  /** An itinerary: today in the project's own zone, for dates printed without a year. */
  readonly projectToday?: string;
}

export interface ExtractionValue {
  readonly kind: DocumentKind;
  readonly answered: number;
  readonly refused: number;
  /** Values shown but never proposed (vendor name, printed subtotal and tax), by field path. */
  readonly read?: Readonly<Record<string, ReadValue | null>>;
  /** A receipt's items. */
  readonly line_items?: readonly ReceiptLineItem[];
  /** Lines against the printed total, computed in code. */
  readonly tie_out?: TieOutResult;
  /** Lines that broke a rule, dropped and never repaired. */
  readonly dropped?: readonly { readonly line: number; readonly reason: ExtractionDropReason }[];
  /** Lines past MAX_DOCUMENT_LINES, dropped. */
  readonly too_many?: number;
}

function describe(kind: DocumentKind, fields: readonly ProposedField[]): string {
  const answered = fields.filter((f) => f.refusal === undefined).length;
  return `Create a ${kind.replaceAll("_", " ")} record from the extracted document with ${answered} of ${fields.length} fields read.`;
}

const KIND_RULES: Partial<Record<DocumentKind, readonly string[]>> = {
  itinerary: [
    "Give one segment per leg, with its passengers. Copy one word-for-word source_excerpt for the whole line, holding the month, day and times.",
    "Give a passenger's price only when the document prints it for that passenger and that segment, with price_excerpt naming them. A total for the whole booking is never a passenger's price.",
    "Times are local as printed, YYYY-MM-DDTHH:MM, never converted to another zone. For each zone give the IANA zone of the printed airport or city, for example America/Chicago, and a confidence no higher than 0.5.",
    "Never give an id for a person. Passengers are names as printed.",
  ],
  contract: [
    "document_type is Contract for a booking agreement, Rider for a technical or hospitality rider, and Other for anything else.",
    "Read the act exactly as printed. Never choose a role, a classification or terms; the person sets those.",
    "Never read a deposit, a split, a payment schedule or a ticket share.",
  ],
  invoice: [
    "Give each line of the invoice with one word-for-word source_excerpt, its description, quantity and unit price as price_minor.",
    "The read list holds the vendor's name, the printed subtotal and the printed tax, never a guess.",
  ],
  receipt: [
    "Give each item with one word-for-word source_excerpt, its description, quantity and the line's amount as price_minor.",
    "The read list holds the vendor's name, the printed subtotal and the printed tax, never a guess.",
  ],
};

export async function extractDocument(
  ctx: AuroraContext,
  input: ExtractionInput,
): Promise<AuroraResult<ExtractionValue>> {
  const kind = input.kind;
  const target = EXTRACTION_TARGETS[kind];
  const feeVisible = kind === "contract" && input.feeVisible === true;
  const headerSpecs = feeVisible ? [...target.fields, ...CONTRACT_FEE_FIELDS] : target.fields;
  const compactKind = kind === "invoice" || kind === "receipt";
  return runFeature(ctx, "extraction", input.subject, async (model, maxTokens) => {
    const system = [
      GUARDRAILS,
      `Task: read the attached ${kind.replaceAll("_", " ")} and fill the fields below.`,
      "For each field give the value, a confidence from 0 to 1, and source_excerpt: the exact words from the document the value came from.",
      "Money is in minor units (USD 1,250.00 is 125000). Dates are YYYY-MM-DD. When the document does not state a field, set value null and say what is missing.",
      "Never quote a passport number or its expiry, a date of birth, a known traveler number or a redress number in a value or an excerpt.",
      ...(KIND_RULES[kind] ?? []),
      ...(kind === "contract" && !feeVisible
        ? ["Never read or quote a fee, a price or any money amount."]
        : []),
      ...(kind === "itinerary"
        ? []
        : [
            headerSpecs.length > 0
              ? `Header fields:\n${fieldList(headerSpecs)}`
              : "This document has no header fields.",
          ]),
      ...(compactKind || kind === "itinerary"
        ? []
        : [
            target.lines
              ? `Each line has these fields:\n${fieldList(target.lines.fields)}`
              : "This document has no lines.",
          ]),
      ...(compactKind ? [`Read list fields:\n${fieldList(READ_FIELDS)}`] : []),
    ].join("\n\n");
    const content = [
      input.document,
      { type: "text" as const, text: dataBlock("file name", input.fileName) },
      { type: "text" as const, text: "Call record_fields with what you read." },
    ];
    const call = async <S extends z.ZodType>(schema: S) => {
      const result = await callTool({
        client: ctx.client,
        model,
        maxTokens,
        system,
        content,
        tool: {
          name: "record_fields",
          description: "Records the fields read from the document.",
          inputSchema: z.toJSONSchema(schema) as Record<string, unknown>,
        },
        schema,
      });
      // A list cut off at the token limit would propose part of the document and give a false residual.
      if (result.stopReason === "max_tokens") {
        throw new FeatureError(
          "model_output_invalid",
          "The document has too many lines for one read.",
        );
      }
      return result;
    };

    let proposals: ProposedChange[] = [];
    let extra: Partial<ExtractionValue> = {};
    let output: string;
    let prompt: string;
    let usage;

    if (kind === "itinerary") {
      const result = await call(ItinerarySchema);
      ({ prompt, output, usage } = result);
      const read = readItinerary(result.value, input.projectToday ?? ctx.today);
      proposals = read.proposals;
      extra = {
        ...(read.dropped.length > 0 ? { dropped: read.dropped } : {}),
        ...(read.tooMany > 0 ? { too_many: read.tooMany } : {}),
      };
    } else if (compactKind) {
      const result = await call(AmountsSchema);
      ({ prompt, output, usage } = result);
      const header = settle(target.fields, result.value.fields);
      const read = readValues(result.value.read);
      proposals.push({
        operationId: target.operationId,
        targetId: null,
        summary: describe(kind, header),
        fields: header,
      });
      const kept = result.value.lines.slice(0, MAX_DOCUMENT_LINES);
      const tooMany = result.value.lines.length - kept.length;
      if (kind === "invoice") {
        kept.forEach((line, i) => {
          const excerpt = line.source_excerpt ? withholdIdentity(line.source_excerpt) : "";
          const strict = (path: string, kindOf: FieldKind, value: number | null): ProposedField =>
            value !== null && excerpt && excerptSupports(kindOf, value, excerpt)
              ? {
                  field_path: path,
                  value,
                  confidence: line.confidence ?? 0,
                  source_excerpt: excerpt,
                }
              : refused(path, UNREAD_VALUE);
          const description = line.description?.trim() ?? "";
          proposals.push({
            operationId: "invoiceLines.create",
            targetId: null,
            summary: `Add line ${i + 1} from the extracted document.`,
            fields: [
              description
                ? {
                    field_path: "description",
                    value: description.slice(0, 500),
                    confidence: line.confidence ?? 0,
                    ...(excerpt ? { source_excerpt: excerpt } : {}),
                  }
                : refused("description", UNREAD_VALUE),
              strict("quantity", "quantity", line.quantity),
              strict(
                "unit_price_minor",
                "money",
                Number.isInteger(line.price_minor) ? line.price_minor : null,
              ),
            ],
          });
        });
        // Printed tax becomes one more line, because app.invoice_totals.tax_minor comes only from a
        // tax rate no Atlas screen sets, and a rate would not round alike. The person may uncheck it.
        const tax = read["printed_tax_minor"];
        if (minorOf(tax) !== null && minorOf(tax) !== 0) {
          proposals.push({
            operationId: "invoiceLines.create",
            targetId: null,
            summary: "Add the printed tax as a line.",
            fields: [
              { field_path: "description", value: "Tax", confidence: 1 },
              { field_path: "quantity", value: 1, confidence: 1 },
              {
                field_path: "unit_price_minor",
                value: minorOf(tax),
                confidence: 1,
                ...(tax?.source_excerpt ? { source_excerpt: tax.source_excerpt } : {}),
              },
            ],
          });
        }
        extra = {
          read,
          tie_out: tieOut({
            lines: proposals.slice(1).map((p) => ({
              quantity: proposedMinor(p.fields, "quantity") ?? 1,
              unitPriceMinor: proposedMinor(p.fields, "unit_price_minor"),
            })),
            printedSubtotalMinor: minorOf(read["printed_subtotal_minor"]),
            printedTotalMinor: proposedMinor(header, "printed_total_minor"),
          }),
        };
      } else {
        const items: ReceiptLineItem[] = kept.map((line) => {
          const excerpt = line.source_excerpt ? withholdIdentity(line.source_excerpt) : "";
          return {
            description: line.description?.trim() || null,
            quantity:
              line.quantity !== null && excerptSupports("quantity", line.quantity, excerpt)
                ? line.quantity
                : null,
            amount_minor:
              Number.isInteger(line.price_minor) &&
              line.price_minor !== null &&
              excerptSupports("money", line.price_minor, excerpt)
                ? line.price_minor
                : null,
            source_excerpt: excerpt || null,
          };
        });
        extra = {
          read,
          line_items: items,
          tie_out: tieOut({
            lines: items.map((item) => ({ quantity: 1, unitPriceMinor: item.amount_minor })),
            printedSubtotalMinor: minorOf(read["printed_subtotal_minor"]),
            printedTaxMinor: minorOf(read["printed_tax_minor"]),
            printedTotalMinor: proposedMinor(header, "amount_minor"),
          }),
        };
      }
      if (tooMany > 0) extra = { ...extra, too_many: tooMany };
    } else {
      const result = await call(ExtractionSchema);
      ({ prompt, output, usage } = result);
      const header =
        kind === "contract"
          ? settleContract(result.value.fields, feeVisible)
          : settle(target.fields, result.value.fields);
      proposals.push({
        operationId: target.operationId,
        targetId: null,
        summary: describe(kind, header),
        fields: header,
      });
      if (target.lines) {
        const lineTarget = target.lines;
        result.value.lines.forEach((line, index) => {
          proposals.push({
            operationId: lineTarget.operationId,
            targetId: null,
            summary: `Add line ${index + 1} from the extracted document.`,
            fields: settle(lineTarget.fields, line.fields),
          });
        });
      }
    }

    const all = proposals.flatMap((p) => p.fields);
    const answered = all.filter((f) => f.refusal === undefined).length;
    // A contract logs no model text: excerpts and `missing` could hold the fee, and audit readers read the log.
    if (kind === "contract") {
      output = `Read ${answered} of ${all.length} fields from one document.`;
    }
    if (answered === 0) {
      return {
        kind: "no-answer",
        missing:
          "No field could be read from this document. Check that it is the right file and legible.",
        prompt,
        output,
        usage,
      };
    }
    return {
      kind: "answer",
      value: { kind, answered, refused: all.length - answered, ...extra },
      prompt,
      output,
      usage,
      proposals,
    };
  });
}
