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
import { callTool, dataBlock, GUARDRAILS } from "./shared.ts";

/**
 * Document extraction (Section 4.7): riders, insurance certificates, invoices, receipts and quotes
 * become proposed fields with a confidence each and provenance agent. Nothing is written until the
 * person confirms. A price, date or quantity the document does not show word for word becomes
 * NO_ANSWER, whatever the model said (Section 3.7).
 */

export const DOCUMENT_KINDS = [
  "rider",
  "insurance_certificate",
  "invoice",
  "receipt",
  "quote",
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** Field kinds. `money`, `date` and `quantity` must be read from the source, never inferred. */
export type FieldKind = "text" | "date" | "money" | "quantity" | "currency";

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
  readonly lines?: { readonly operationId: string; readonly fields: readonly ExtractionField[] };
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
  },
  invoice: {
    operationId: "invoices.create",
    fields: [
      { path: "invoice_number", kind: "text", description: "Invoice number as printed." },
      { path: "issued_on", kind: "date", description: "Issue date, YYYY-MM-DD." },
      { path: "due_on", kind: "date", description: "Due date, YYYY-MM-DD." },
      { path: "currency", kind: "currency", description: "ISO 4217 currency." },
    ],
  },
  receipt: {
    operationId: "expenses.create",
    fields: [
      { path: "description", kind: "text", description: "What was bought, in a short phrase." },
      { path: "amount_minor", kind: "money", description: "Total paid in minor units." },
      { path: "currency", kind: "currency", description: "ISO 4217 currency." },
      { path: "incurred_on", kind: "date", description: "Purchase date, YYYY-MM-DD." },
    ],
  },
  quote: {
    operationId: "bids.create",
    fields: [
      { path: "notes", kind: "text", description: "Terms and conditions stated on the quote." },
    ],
    lines: {
      operationId: "bidLines.create",
      fields: [
        { path: "description", kind: "text", description: "Line description." },
        { path: "quantity", kind: "quantity", description: "Quantity quoted." },
        { path: "unit_price_minor", kind: "money", description: "Unit price in minor units." },
        { path: "currency", kind: "currency", description: "ISO 4217 currency." },
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
});
type RawField = z.infer<typeof FieldValue>;

const STRICT_KINDS: ReadonlySet<FieldKind> = new Set(["money", "date", "quantity"]);

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

/** Applies the silence rule to one field. Unknown paths are dropped; unsupported values refuse. */
export function settleField(spec: ExtractionField, raw: RawField | undefined): ProposedField {
  const refuse = (missing: string): ProposedField => ({
    field_path: spec.path,
    refusal: "NO_ANSWER",
    missing,
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
  return {
    field_path: spec.path,
    value: spec.kind === "money" || spec.kind === "quantity" ? Number(raw.value) : raw.value,
    confidence: raw.confidence ?? 0,
    ...(raw.source_excerpt ? { source_excerpt: raw.source_excerpt } : {}),
  };
}

function settle(fields: readonly ExtractionField[], raw: readonly RawField[]): ProposedField[] {
  const byPath = new Map(raw.map((f) => [f.field_path, f]));
  return fields.map((spec) => settleField(spec, byPath.get(spec.path)));
}

function fieldList(fields: readonly ExtractionField[]): string {
  return fields.map((f) => `- ${f.path} (${f.kind}): ${f.description}`).join("\n");
}

export interface ExtractionInput {
  readonly kind: DocumentKind;
  readonly document: DocumentContent;
  readonly fileName: string;
  /** The stored document row, so the request log names it. */
  readonly subject: Subject | null;
}

export interface ExtractionValue {
  readonly kind: DocumentKind;
  readonly answered: number;
  readonly refused: number;
}

function describe(kind: DocumentKind, fields: readonly ProposedField[]): string {
  const answered = fields.filter((f) => f.refusal === undefined).length;
  const label = kind.replaceAll("_", " ");
  return `Create a ${label} record from the extracted document with ${answered} of ${fields.length} fields read.`;
}

export async function extractDocument(
  ctx: AuroraContext,
  input: ExtractionInput,
): Promise<AuroraResult<ExtractionValue>> {
  const target = EXTRACTION_TARGETS[input.kind];
  return runFeature(ctx, "extraction", input.subject, async (model, maxTokens) => {
    const system = [
      GUARDRAILS,
      `Task: read the attached ${input.kind.replaceAll("_", " ")} and fill the fields below.`,
      "For each field give the value, a confidence from 0 to 1, and source_excerpt: the exact words from the document the value came from.",
      "Money is in minor units (USD 1,250.00 is 125000). Dates are YYYY-MM-DD. When the document does not state a field, set value null and say what is missing.",
      `Header fields:\n${fieldList(target.fields)}`,
      target.lines
        ? `Each line has these fields:\n${fieldList(target.lines.fields)}`
        : "This document has no lines.",
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

    const header = settle(target.fields, result.value.fields);
    const proposals: ProposedChange[] = [
      {
        operationId: target.operationId,
        targetId: null,
        summary: describe(input.kind, header),
        fields: header,
      },
    ];
    if (target.lines) {
      const lineTarget = target.lines;
      result.value.lines.forEach((line, index) => {
        const fields = settle(lineTarget.fields, line.fields);
        proposals.push({
          operationId: lineTarget.operationId,
          targetId: null,
          summary: `Add line ${index + 1} from the extracted document.`,
          fields,
        });
      });
    }
    const all = proposals.flatMap((p) => p.fields);
    const answered = all.filter((f) => f.refusal === undefined).length;
    if (answered === 0) {
      return {
        kind: "no-answer",
        missing:
          "No field could be read from this document. Check that it is the right file and legible.",
        prompt: result.prompt,
        output: result.output,
        usage: result.usage,
      };
    }
    return {
      kind: "answer",
      value: { kind: input.kind, answered, refused: all.length - answered },
      prompt: result.prompt,
      output: result.output,
      usage: result.usage,
      proposals,
    };
  });
}
