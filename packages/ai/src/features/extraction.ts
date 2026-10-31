import { z } from "zod";
import type { DocumentContent } from "../model.ts";
import {
  runFeature,
  type AuroraContext,
  type AuroraResult,
  type ProposedChange,
  type ProposedField,
  type Subject,
} from "../session.ts";
import { withholdIdentity } from "../redact.ts";
import { computeTieOut, type TieOut } from "../tieout.ts";
import { callTool, dataBlock, GUARDRAILS } from "./shared.ts";

/**
 * Document extraction (Section 4.7): riders, insurance certificates, invoices, receipts and quotes
 * become proposed fields with a confidence each and provenance agent. Nothing is written until the
 * person confirms. A price, date or quantity the document does not show word for word becomes
 * NO_ANSWER, whatever the model said (Section 3.7).
 *
 * B15 adds intake kinds: itineraries (one segment per passenger and segment), booking contracts
 * and the riders read with them, and the line items of invoices and receipts with a deterministic
 * tie-out against the printed totals. A contract's fee is Restricted: it is asked of the model only
 * for a caller who reads pay rates, and the log never shows it or any money amount of the contract.
 */

export const DOCUMENT_KINDS = [
  "rider",
  "insurance_certificate",
  "invoice",
  "receipt",
  "quote",
  "itinerary",
  "contract",
  "intake_rider",
  "invoice_lines",
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/**
 * Field kinds. `money`, `date`, `quantity` and `local_datetime` must be read from the source, never
 * inferred. `local_datetime` is a wall-clock time on a day, YYYY-MM-DDTHH:MM, in no zone.
 */
export type FieldKind = "text" | "date" | "money" | "quantity" | "currency" | "local_datetime";

/** The capability a Restricted proposed value needs (private.ai_restricted_fields, 3040). */
export type RestrictedCapability = "data.restricted.read.payroll";

export interface ExtractionField {
  readonly path: string;
  readonly kind: FieldKind;
  readonly description: string;
  /** A Restricted value: asked of the model only for a caller who holds the capability. */
  readonly restricted?: RestrictedCapability;
  /** A text value held to a closed rule: a travel mode, or an IANA time zone. */
  readonly rule?: "travel_mode" | "time_zone";
}

export interface ExtractionTarget {
  /** Public API operation the header fields feed. */
  readonly operationId: string;
  readonly fields: readonly ExtractionField[];
  /** False when the document proposes no header change, only lines. */
  readonly header?: false;
  /** Header values read for checks such as the tie-out: returned in the value, never proposed. */
  readonly check?: readonly ExtractionField[];
  /** Repeating lines (quote lines, rider lines), each proposed as its own change. */
  readonly lines?: {
    readonly operationId: string;
    readonly fields: readonly ExtractionField[];
    /** The most lines one document proposes; the rest are dropped and counted. */
    readonly max?: number;
  };
  /** Lines read for checks only (a receipt's items): returned in the value, never proposed. */
  readonly checkLines?: readonly ExtractionField[];
}

/** Printed totals, as the tie-out reads them (`../tieout.ts`). */
const printed = (what: string): ExtractionField => ({
  path: `printed_${what}_minor`,
  kind: "money",
  description: `The ${what} the document prints, in minor units; null when it prints none.`,
});

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
  // counterparty, budget line and vendor come from the person, never from the document.
  invoice: {
    operationId: "invoices.create",
    fields: [
      { path: "invoice_number", kind: "text", description: "Invoice number as printed." },
      { path: "issued_on", kind: "date", description: "Issue date, YYYY-MM-DD." },
      { path: "due_on", kind: "date", description: "Due date, YYYY-MM-DD." },
      { path: "currency_code", kind: "currency", description: "ISO 4217 currency." },
    ],
  },
  // The expense is the printed total (B15 adds the items and the tie-out, read-only).
  receipt: {
    operationId: "expenses.create",
    fields: [
      { path: "description", kind: "text", description: "What was bought, in a short phrase." },
      { path: "amount_minor", kind: "money", description: "Total paid in minor units." },
      { path: "currency_code", kind: "currency", description: "ISO 4217 currency." },
      { path: "incurred_on", kind: "date", description: "Purchase date, YYYY-MM-DD." },
    ],
    check: [printed("subtotal"), printed("tax"), printed("tip"), printed("total")],
    checkLines: [
      { path: "description", kind: "text", description: "The item as printed." },
      { path: "quantity", kind: "quantity", description: "Quantity, if printed." },
      { path: "amount_minor", kind: "money", description: "The line's amount in minor units." },
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
  // B15 intake kinds. An itinerary proposes one segment per passenger and segment, filed together
  // by auroraIntakes.applyItineraries; the traveler and the instants come from the person.
  itinerary: {
    operationId: "auroraIntakes.applyItineraries",
    header: false,
    fields: [],
    lines: {
      operationId: "auroraIntakes.applyItineraries",
      max: 60,
      fields: [
        { path: "passenger_name", kind: "text", description: "The passenger's name as printed." },
        {
          path: "travel_mode",
          kind: "text",
          rule: "travel_mode",
          description: "Flight, or Ground for a car, shuttle or rail.",
        },
        { path: "operator_name", kind: "text", description: "Airline or ground operator." },
        { path: "service_identifier", kind: "text", description: "Flight or service number." },
        {
          path: "confirmation_identifier",
          kind: "text",
          description: "Booking or record locator code.",
        },
        {
          path: "departs_from",
          kind: "text",
          description: "Departure airport, station or address.",
        },
        {
          path: "departs_local",
          kind: "local_datetime",
          description: "Departure date and local time, YYYY-MM-DDTHH:MM.",
        },
        {
          path: "departs_time_zone",
          kind: "text",
          rule: "time_zone",
          description: "IANA time zone of the departure place, for example America/Chicago.",
        },
        {
          path: "arrives_at_place",
          kind: "text",
          description: "Arrival airport, station or address.",
        },
        {
          path: "arrives_local",
          kind: "local_datetime",
          description: "Arrival date and local time, YYYY-MM-DDTHH:MM.",
        },
        {
          path: "arrives_time_zone",
          kind: "text",
          rule: "time_zone",
          description: "IANA time zone of the arrival place.",
        },
        {
          path: "price_minor",
          kind: "money",
          description:
            "This passenger's fare for this segment in minor units, only when printed for them.",
        },
        { path: "currency_code", kind: "currency", description: "ISO 4217 currency of the fare." },
      ],
    },
  },
  // A booking contract becomes an Artist engagement through auroraIntakes.applyContracts; the role, the
  // classification, the terms and the party come from the person (ADR 0154).
  contract: {
    operationId: "auroraIntakes.applyContracts",
    fields: [
      { path: "act_name", kind: "text", description: "The act or artist booked, as printed." },
      {
        path: "contracting_party",
        kind: "text",
        description: "The company or person signing for the act, as printed.",
      },
      { path: "start_date", kind: "date", description: "First performance or engagement date." },
      { path: "end_date", kind: "date", description: "Last date of the engagement." },
      {
        path: "fee_minor",
        kind: "money",
        restricted: "data.restricted.read.payroll",
        description: "The guaranteed fee in minor units.",
      },
      { path: "currency_code", kind: "currency", description: "ISO 4217 currency of the fee." },
    ],
  },
  // A rider read in a contract intake carries the act it belongs to, so the preview sorts it.
  intake_rider: {
    operationId: "riders.create",
    fields: [
      { path: "act_name", kind: "text", description: "The act the rider belongs to." },
      { path: "title", kind: "text", description: "Rider title, for example Technical Rider." },
    ],
    lines: {
      operationId: "riderLines.create",
      max: 100,
      fields: [
        { path: "description", kind: "text", description: "The ask as the rider states it." },
        { path: "quantity", kind: "quantity", description: "Quantity required, if stated." },
      ],
    },
  },
  // The lines of a payable invoice, confirmed with the invoice id, line number and the person's
  // budget line; the printed totals feed the tie-out only.
  invoice_lines: {
    operationId: "invoiceLines.create",
    header: false,
    fields: [],
    check: [
      printed("subtotal"),
      printed("tax"),
      printed("shipping"),
      printed("total"),
      { path: "currency_code", kind: "currency", description: "ISO 4217 currency of the invoice." },
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
};

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
  check: z.array(FieldValue).default([]),
  check_lines: z.array(z.object({ fields: z.array(FieldValue) })).default([]),
});
type RawField = z.infer<typeof FieldValue>;

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

/** How a local date and time was read, beyond the plain rule. */
export interface DateReading {
  /** Years printed in a full date anywhere in the document, for the airline DDMMM form. */
  readonly documentYears?: ReadonlySet<string>;
  /** The departure's local value, for an arrival printed with +1 or +2. */
  readonly departsLocal?: string | null;
}

/** The time of a local datetime as an excerpt may print it: 08:15, 8:15 or 8:15 am. */
function showsTime(hh: string, mm: string, text: string): boolean {
  const h = Number(hh);
  const twelve = ((h + 11) % 12) + 1;
  const meridiem = h < 12 ? "a" : "p";
  return (
    new RegExp(`(^|[^0-9])(${hh}|${h}):${mm}([^0-9]|$)`).test(text) ||
    new RegExp(`(^|[^0-9])${twelve}:${mm}\\s*${meridiem}\\.?m\\b`).test(text)
  );
}

/** The day after a YYYY-MM-DD day plus n days, on the calendar. */
function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * How the excerpt supports a local datetime: `printed` when it shows the date and the time,
 * `inferred_year` when it shows the airline DDMMM form (03NOV) and the year is printed in a full
 * date elsewhere in the document, `next_day` when an arrival is printed with +1 or +2 after the
 * departure's date, and null otherwise.
 */
export function localDateTimeSupport(
  value: string,
  excerpt: string,
  reading: DateReading = {},
): "printed" | "inferred_year" | "next_day" | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  const [, y, m, d, hh, mm] = match as unknown as [string, string, string, string, string, string];
  const text = excerpt.toLowerCase();
  if (!showsTime(hh, mm, text)) return null;
  const day = `${y}-${m}-${d}`;
  if (excerptSupports("date", day, excerpt)) return "printed";
  const month = MONTHS[Number(m) - 1] ?? "";
  if (new RegExp(`(^|[^0-9])${d}${month}([^a-z]|$)`).test(text) && reading.documentYears?.has(y)) {
    return "inferred_year";
  }
  const offset = /\+\s?([12])\b/.exec(text);
  const departs = reading.departsLocal?.slice(0, 10);
  if (
    offset &&
    departs &&
    /^\d{4}-\d{2}-\d{2}$/.test(departs) &&
    addDays(departs, Number(offset[1])) === day
  ) {
    return "next_day";
  }
  return null;
}

/** Years of the full dates a text prints (numeric, ISO or with a month name). */
export function printedYears(text: string): Set<string> {
  const years = new Set<string>();
  const lower = text.toLowerCase();
  const patterns = [
    /\b(\d{4})-\d{2}-\d{2}\b/g,
    /\b\d{1,2}[/.]\d{1,2}[/.](\d{4})\b/g,
    /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+(\d{4})\b/g,
    /\b\d{1,2}\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(\d{4})\b/g,
  ];
  for (const pattern of patterns) {
    for (const found of lower.matchAll(pattern)) if (found[1]) years.add(found[1]);
  }
  return years;
}

/** True when the excerpt visibly carries the value, so it was read, not inferred. */
export function excerptSupports(kind: FieldKind, value: string | number, excerpt: string): boolean {
  const text = excerpt.toLowerCase();
  if (kind === "local_datetime") {
    return localDateTimeSupport(String(value), excerpt) === "printed";
  }
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

/** True for an IANA time zone this runtime knows. */
export function isTimeZone(zone: string): boolean {
  if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$|^UTC$/.test(zone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Why a field was left unread for a caller who may not read its Restricted value. */
export const RESTRICTED_MISSING = "Fees are read only by someone who may see pay rates.";

export interface SettleOptions extends DateReading {
  /** Capabilities the caller holds, for Restricted fields. */
  readonly readable?: ReadonlySet<RestrictedCapability>;
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
    missing,
  });
  if (spec.restricted && !(options.readable?.has(spec.restricted) ?? false)) {
    return refuse(RESTRICTED_MISSING);
  }
  if (!raw || raw.value === null || raw.value === "") {
    return refuse(raw?.missing ?? `The document does not state ${spec.description.toLowerCase()}`);
  }
  if (spec.kind === "local_datetime") {
    if (
      !raw.source_excerpt ||
      localDateTimeSupport(String(raw.value), raw.source_excerpt, options) === null
    ) {
      return refuse("The document does not show this date and time, so it was not guessed.");
    }
  } else if (STRICT_KINDS.has(spec.kind)) {
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
  let value: unknown =
    spec.kind === "money" || spec.kind === "quantity" ? Number(raw.value) : raw.value;
  if (spec.rule === "travel_mode") {
    const mode = String(raw.value).trim().toLowerCase();
    if (mode !== "flight" && mode !== "ground") {
      return refuse("The travel mode is Flight or Ground; the document shows neither.");
    }
    value = mode === "flight" ? "Flight" : "Ground";
  }
  if (spec.rule === "time_zone" && !isTimeZone(String(raw.value))) {
    return refuse("No valid IANA time zone could be read for this place.");
  }
  return {
    field_path: spec.path,
    value,
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

/** Fields a caller may have read: Restricted ones only with their capability. */
function askable(fields: readonly ExtractionField[], readable: ReadonlySet<RestrictedCapability>) {
  return fields.filter((f) => !f.restricted || readable.has(f.restricted));
}

/** Money amounts next to a currency sign or code, as a contract's dates or terms may quote them. */
const CODES = "USD|EUR|GBP|CAD|AUD|NZD|MXN|JPY|CHF|SEK|NOK|DKK|BRL|ZAR|INR|CNY|HKD|SGD|AED";
const MONEY_AMOUNT = new RegExp(
  `(?:[$€£¥]\\s?|\\b(?:${CODES})\\s?)\\d[\\d,]*(?:\\.\\d+)?|\\d[\\d,]*(?:\\.\\d+)?\\s?(?:[$€£¥]|\\b(?:${CODES})\\b)`,
  "g",
);

/** Replaces money amounts with [Restricted], for the logs and excerpts of a contract. */
export function scrubMoney(text: string): string {
  return text.replace(MONEY_AMOUNT, "[Restricted]");
}

export interface ExtractionInput {
  readonly kind: DocumentKind;
  readonly document: DocumentContent;
  readonly fileName: string;
  /** The stored document row, so the request log names it. */
  readonly subject: Subject | null;
  /** Restricted capabilities the caller holds, read from the database by the caller (never a client flag). */
  readonly readable?: readonly RestrictedCapability[];
  /** The invoice's currency, so invoice lines flag a document in another one. */
  readonly invoiceCurrency?: string;
}

/** A value read for a check, never proposed. */
export interface CheckValue {
  readonly value: unknown;
  readonly source_excerpt: string | null;
}

export interface ExtractionValue {
  readonly kind: DocumentKind;
  readonly answered: number;
  readonly refused: number;
  /** Header values read for checks (printed totals, the invoice currency), by field path. */
  readonly check?: Readonly<Record<string, CheckValue | null>>;
  /** A receipt's items, read-only. */
  readonly lines?: readonly Readonly<Record<string, CheckValue | null>>[];
  /** The tie-out of the lines against the printed totals (`../tieout.ts`). */
  readonly tie_out?: TieOut & { readonly flags: readonly "currency_mismatch"[] };
  /** Lines beyond the kind's cap, dropped. */
  readonly dropped?: number;
  /** Line positions (0-based) whose date was the airline DDMMM form with the document's year. */
  readonly inferred_year?: readonly number[];
}

function describe(kind: DocumentKind, fields: readonly ProposedField[]): string {
  const answered = fields.filter((f) => f.refusal === undefined).length;
  const label = kind === "intake_rider" ? "rider" : kind.replaceAll("_", " ");
  return `Create a ${label} record from the extracted document with ${answered} of ${fields.length} fields read.`;
}

function lineSummary(kind: DocumentKind, index: number, fields: readonly ProposedField[]): string {
  if (kind === "itinerary") {
    const at = (path: string) => {
      const f = fields.find((x) => x.field_path === path);
      return f?.refusal === undefined && typeof f?.value === "string" ? f.value : "an unread place";
    };
    return `Add segment ${index + 1}: ${at("departs_from")} to ${at("arrives_at_place")}.`;
  }
  return `Add line ${index + 1} from the extracted document.`;
}

const checkValue = (field: ProposedField): CheckValue | null =>
  field.refusal === undefined
    ? { value: field.value ?? null, source_excerpt: field.source_excerpt ?? null }
    : null;

const checkRecord = (fields: readonly ProposedField[]) =>
  Object.fromEntries(fields.map((f) => [f.field_path, checkValue(f)]));

const numberOf = (
  record: Readonly<Record<string, CheckValue | null>>,
  path: string,
): number | null => {
  const v = record[path]?.value;
  return typeof v === "number" && Number.isInteger(v) ? v : null;
};

/** The passenger's last name as a check that a fare was printed for them. */
function namesPassenger(fields: readonly ProposedField[], excerpt: string | undefined): boolean {
  const name = fields.find((f) => f.field_path === "passenger_name");
  if (!excerpt || name?.refusal !== undefined || typeof name?.value !== "string") return false;
  const parts = name.value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((p) => p.length > 1);
  const folded = excerpt.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return parts.some((p) => new RegExp(`\\b${p}\\b`).test(folded));
}

export async function extractDocument(
  ctx: AuroraContext,
  input: ExtractionInput,
): Promise<AuroraResult<ExtractionValue>> {
  const target = EXTRACTION_TARGETS[input.kind];
  const readable = new Set(input.readable ?? []);
  const headerFields = target.header === false ? [] : askable(target.fields, readable);
  const restrictedPaths = new Set(target.fields.filter((f) => f.restricted).map((f) => f.path));
  const contract = input.kind === "contract";
  return runFeature(ctx, "extraction", input.subject, async (model, maxTokens) => {
    const system = [
      GUARDRAILS,
      `Task: read the attached ${input.kind === "intake_rider" ? "rider" : input.kind.replaceAll("_", " ")} and fill the fields below.`,
      "For each field give the value, a confidence from 0 to 1, and source_excerpt: the exact words from the document the value came from.",
      "Money is in minor units (USD 1,250.00 is 125000). Dates are YYYY-MM-DD and local times YYYY-MM-DDTHH:MM as printed, never converted to another zone. When the document does not state a field, set value null and say what is missing.",
      "Never quote a passport number or its expiry, a date of birth, a known traveler number or a redress number in a value or an excerpt.",
      ...(input.kind === "itinerary"
        ? [
            "Give one line per passenger and segment: a booking for three passengers on two flights is six lines.",
            "Read a fare only when the document prints it for that passenger and segment. Never split a total paid for several passengers.",
            "A time zone is the IANA zone of the place, for example America/New_York; leave it null when the place is unclear.",
          ]
        : []),
      ...(contract
        ? [
            "Read the act and the contracting party exactly as printed. Never choose a role, a classification or terms; the person sets those.",
          ]
        : []),
      headerFields.length > 0
        ? `Header fields:\n${fieldList(headerFields)}`
        : "This document has no header fields.",
      ...(target.check ? [`Check fields, read for totals only:\n${fieldList(target.check)}`] : []),
      target.lines
        ? `Each line has these fields:\n${fieldList(target.lines.fields)}`
        : "This document has no lines.",
      ...(target.checkLines
        ? [`Each check line (the items) has these fields:\n${fieldList(target.checkLines)}`]
        : []),
    ].join("\n\n");
    const result = await callTool({
      client: ctx.client,
      model,
      maxTokens,
      system,
      content: [
        input.document,
        { type: "text", text: dataBlock("file name", input.fileName) },
        { type: "text", text: "Call record_fields with every field." },
      ],
      tool: {
        name: "record_fields",
        description: "Records the fields read from the document.",
        inputSchema: z.toJSONSchema(ExtractionSchema) as Record<string, unknown>,
      },
      schema: ExtractionSchema,
    });

    const raw = result.value;
    const excerpts = [
      ...raw.fields,
      ...raw.check,
      ...raw.lines.flatMap((l) => l.fields),
      ...raw.check_lines.flatMap((l) => l.fields),
    ]
      .map((f) => f.source_excerpt ?? "")
      .join("\n");
    const documentYears = printedYears(
      input.document.mediaType === "text/plain" ? `${input.document.data}\n${excerpts}` : excerpts,
    );
    // A contract's other excerpts may quote the fee, so their money amounts are withheld.
    const scrubExcerpt = (field: ProposedField): ProposedField =>
      contract && !restrictedPaths.has(field.field_path) && field.source_excerpt
        ? { ...field, source_excerpt: scrubMoney(field.source_excerpt) }
        : field;

    const proposals: ProposedChange[] = [];
    if (target.header !== false) {
      const header = settle(target.fields, raw.fields, { readable }).map(scrubExcerpt);
      proposals.push({
        operationId: target.operationId,
        targetId: null,
        summary: describe(input.kind, header),
        fields: header,
      });
    }
    let dropped = 0;
    const inferredYear: number[] = [];
    if (target.lines) {
      const lineTarget = target.lines;
      raw.lines.forEach((line, index) => {
        if (lineTarget.max !== undefined && index >= lineTarget.max) {
          dropped += 1;
          return;
        }
        const byPath = new Map(line.fields.map((f) => [f.field_path, f]));
        const departs = byPath.get("departs_local");
        const reading: SettleOptions = {
          readable,
          documentYears,
          departsLocal: typeof departs?.value === "string" ? departs.value : null,
        };
        let fields = lineTarget.fields.map((spec) => {
          // Only an arrival may read +1 or +2 from its departure.
          const options =
            spec.path === "arrives_local" ? reading : { ...reading, departsLocal: null };
          return settleField(spec, byPath.get(spec.path), options);
        });
        if (input.kind === "itinerary") {
          fields = fields.map((f) =>
            f.field_path === "price_minor" &&
            f.refusal === undefined &&
            !namesPassenger(fields, f.source_excerpt)
              ? {
                  field_path: f.field_path,
                  refusal: "NO_ANSWER" as const,
                  missing:
                    "The fare is not printed for this passenger, so it was not split or guessed.",
                }
              : f,
          );
          const years = ["departs_local", "arrives_local"].some((path) => {
            const r = byPath.get(path);
            return (
              typeof r?.value === "string" &&
              r.source_excerpt &&
              localDateTimeSupport(r.value, r.source_excerpt, reading) === "inferred_year"
            );
          });
          if (years) inferredYear.push(proposals.length - (target.header === false ? 0 : 1));
        }
        proposals.push({
          operationId: lineTarget.operationId,
          targetId: null,
          summary: lineSummary(input.kind, index, fields),
          fields: fields.map(scrubExcerpt),
        });
      });
    }

    const all = proposals.flatMap((p) => p.fields);
    const answered = all.filter((f) => f.refusal === undefined).length;
    const output = contract ? contractOutput(raw, restrictedPaths) : result.output;
    if (answered === 0) {
      return {
        kind: "no-answer",
        missing:
          "No field could be read from this document. Check that it is the right file and legible.",
        prompt: result.prompt,
        output,
        usage: result.usage,
      };
    }

    // Checks: printed totals and a receipt's items, returned in the value only.
    const check = target.check ? checkRecord(settle(target.check, raw.check)) : undefined;
    const checkLines = target.checkLines
      ? raw.check_lines.map((l) => checkRecord(settle(target.checkLines ?? [], l.fields)))
      : undefined;
    let tieOut: ExtractionValue["tie_out"];
    if (check && (input.kind === "invoice_lines" || input.kind === "receipt")) {
      const lines =
        input.kind === "invoice_lines"
          ? proposals.map((p) => {
              const get = (path: string) => p.fields.find((f) => f.field_path === path);
              const q = get("quantity");
              const price = get("unit_price_minor");
              return {
                quantity: q?.refusal === undefined ? (q?.value as number) : null,
                unitPriceMinor: price?.refusal === undefined ? (price?.value as number) : null,
              };
            })
          : (checkLines ?? []).map((l) => ({
              quantity: 1,
              unitPriceMinor: numberOf(l, "amount_minor"),
            }));
      const currency = check["currency_code"]?.value;
      tieOut = {
        ...computeTieOut({
          lines,
          printed: {
            subtotal: numberOf(check, "printed_subtotal_minor"),
            tax: numberOf(check, "printed_tax_minor"),
            shipping: numberOf(check, "printed_shipping_minor"),
            tip: numberOf(check, "printed_tip_minor"),
            total: numberOf(check, "printed_total_minor"),
          },
        }),
        flags:
          input.invoiceCurrency &&
          typeof currency === "string" &&
          currency !== input.invoiceCurrency
            ? ["currency_mismatch"]
            : [],
      };
    }
    return {
      kind: "answer",
      value: {
        kind: input.kind,
        answered,
        refused: all.length - answered,
        ...(check ? { check } : {}),
        ...(checkLines ? { lines: checkLines } : {}),
        ...(tieOut ? { tie_out: tieOut } : {}),
        ...(dropped > 0 ? { dropped } : {}),
        ...(input.kind === "itinerary" ? { inferred_year: inferredYear } : {}),
      },
      prompt: result.prompt,
      output,
      usage: result.usage,
      proposals,
    };
  });
}

/** A contract's model output as logged: Restricted values and their excerpts, and every money amount, withheld. */
function contractOutput(
  raw: z.infer<typeof ExtractionSchema>,
  restricted: ReadonlySet<string>,
): string {
  const field = (f: RawField) =>
    restricted.has(f.field_path)
      ? {
          ...f,
          value: f.value === null ? null : "[Restricted]",
          source_excerpt: f.source_excerpt === null ? null : "[Restricted]",
        }
      : f;
  const safe = { ...raw, fields: raw.fields.map(field) };
  return scrubMoney(`record_fields ${JSON.stringify(safe)}`);
}
