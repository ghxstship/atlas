/**
 * Expenses in Compass (Section 4.3 item 11: "receipt capture with OCR prefill, posting to a budget line"; A92).
 *
 * A receipt photo is read by Aurora's document extraction when the org has it on (Section 4.7), which proposes the
 * description, amount, currency and date with a confidence each and never guesses a value the receipt does not show.
 * The person checks every field, picks the budget line, and saves. The save is one offline write: the photo uploads to
 * field-media under the line's project, then app.submit_expense_receipt (1490) files the expense with its receipt and
 * applies the confirmed suggestion. Nothing about the person or the org goes to the model: the request carries the
 * photo (re-encoded, so without EXIF location) and a fixed file name, nothing else.
 */
import type { AuroraClient, AuroraProblem } from "@xos/ai/client";
import { uuidv7, type MutationInput } from "@xos/sync";

/** A budget line as the picker shows it (source budget_lines): no amounts. */
export interface BudgetLineRow {
  readonly id: string;
  readonly org_id: string;
  readonly project_id: string;
  readonly budget_name: string;
  readonly currency_code: string;
  readonly is_baseline: boolean;
  readonly line_number: number;
  readonly description: string;
  readonly urid?: string | null;
}

/** An expense on the device (source expenses, or the optimistic row of a queued save). */
export interface ExpenseRow {
  readonly id: string;
  readonly org_id?: string;
  readonly budget_line_id: string;
  readonly submitter_person_id: string | null;
  readonly description: string;
  readonly incurred_on: string;
  readonly amount_minor: number;
  readonly currency_code: string;
  readonly expense_state: string;
  readonly created_at?: string | null;
}

/**
 * The lines a person picks from on a project: the working budgets' lines, or the baseline's when the project has
 * only a baseline (the gate 3 baseline is what the final cost report compares against, not where costs post).
 */
export function postableLines(
  lines: readonly BudgetLineRow[],
  projectId: string | null,
): BudgetLineRow[] {
  const onProject = lines.filter((l) => l.project_id === projectId);
  const working = onProject.filter((l) => !l.is_baseline);
  return (working.length > 0 ? working : onProject)
    .slice()
    .sort((a, b) => a.budget_name.localeCompare(b.budget_name) || a.line_number - b.line_number);
}

// Money --------------------------------------------------------------------------------------------------------

/** ISO 4217 currencies whose minor unit is not hundredths. */
const MINOR_DIGITS: Readonly<Record<string, number>> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
};

export function minorDigits(currency: string): number {
  return MINOR_DIGITS[currency.toUpperCase()] ?? 2;
}

/**
 * An amount typed in the currency's major unit ("42.50", "42,50", "1,234.56", "1.234,56") as minor units, or null
 * when it is not a positive amount the currency can hold.
 */
export function parseAmount(text: string, currency: string): number | null {
  const digits = minorDigits(currency);
  const cleaned = text.replace(/\s/g, "").replace(/[^0-9.,]/g, "");
  if (!/\d/.test(cleaned)) return null;
  const lastDot = cleaned.lastIndexOf(".");
  const lastComma = cleaned.lastIndexOf(",");
  const sep = Math.max(lastDot, lastComma);
  let whole = cleaned;
  let fraction = "";
  if (sep !== -1) {
    const tail = cleaned.slice(sep + 1);
    const single = (lastDot === -1) !== (lastComma === -1);
    // One kind of mark followed by exactly three digits is a thousands mark (1,234 or 1.234), not a decimal one.
    const thousands = single && tail.length === 3 && digits !== 3;
    if (!thousands) {
      whole = cleaned.slice(0, sep);
      fraction = tail;
    }
  }
  // Marks left in the whole part group thousands: 1,234,567 but never 1.2.
  const groups = whole.split(/[.,]/);
  if (
    groups.length > 1 &&
    (!/^\d{1,3}$/.test(groups[0] ?? "") || groups.slice(1).some((g) => !/^\d{3}$/.test(g)))
  )
    return null;
  whole = groups.join("");
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(fraction) || fraction.length > digits) return null;
  const minor = Number(`${whole || "0"}${fraction.padEnd(digits, "0")}`);
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

/** Minor units as the amount a person types back ("42.50"), for a field prefilled from the receipt. */
export function amountText(minor: number, currency: string): string {
  const digits = minorDigits(currency);
  if (digits === 0) return String(minor);
  const text = String(Math.abs(minor)).padStart(digits + 1, "0");
  return `${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

/** Minor units as money in the person's language, such as $42.50 or 42,50 US$. */
export function formatMoney(minor: number, currency: string, locale?: string): string {
  const digits = minorDigits(currency);
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(minor / 10 ** digits);
  } catch {
    return `${amountText(minor, currency)} ${currency}`;
  }
}

// Dates --------------------------------------------------------------------------------------------------------

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date written YYYY-MM-DD. */
export function isIsoDay(text: string): boolean {
  const match = ISO_DAY.exec(text.trim());
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === text.trim();
}

// The form -------------------------------------------------------------------------------------------------------

export interface ExpenseDraft {
  readonly budgetLineId: string | null;
  readonly description: string;
  readonly amount: string;
  readonly incurredOn: string;
}

export type DraftProblem = "line" | "description" | "amount" | "date" | "future";

/**
 * What stops the draft from saving, in form order. `today` is the date on the project's calendar, so a receipt from
 * this evening is not "in the future" for a project in another zone (A71).
 */
export function draftProblems(
  draft: ExpenseDraft,
  currency: string | null,
  today: string,
): DraftProblem[] {
  const problems: DraftProblem[] = [];
  if (!draft.budgetLineId || !currency) problems.push("line");
  const description = draft.description.trim();
  if (description.length === 0 || description.length > 500) problems.push("description");
  if (!currency || parseAmount(draft.amount, currency) === null) problems.push("amount");
  if (!isIsoDay(draft.incurredOn)) problems.push("date");
  else if (draft.incurredOn.trim() > today) problems.push("future");
  return problems;
}

// Aurora --------------------------------------------------------------------------------------------------------

/** The extraction request, built here so nothing but the photo reaches the model (Section 4.7). */
export interface ReceiptExtractionRequest {
  readonly kind: "receipt";
  readonly media_type: "image/jpeg";
  readonly content_base64: string;
  readonly file_name: string;
  readonly document_id: null;
}

/** A fixed file name: the request log never names a person, a project or a vendor. */
export const RECEIPT_FILE_NAME = "receipt.jpg";

export function receiptExtractionRequest(jpegBase64: string): ReceiptExtractionRequest {
  return {
    kind: "receipt",
    media_type: "image/jpeg",
    content_base64: jpegBase64,
    file_name: RECEIPT_FILE_NAME,
    document_id: null,
  };
}

/** One proposed field as the public API returns it (AiSuggestionField). */
export interface SuggestionField {
  readonly field_path: string;
  readonly proposed_value: unknown;
  readonly confidence: number | null;
  readonly refusal: "NO_ANSWER" | null;
  readonly missing: string | null;
}

export interface ProposedValue<T> {
  readonly value: T;
  readonly confidence: number;
}

/** What Aurora read from the receipt, field by field; a field it could not read carries what was missing. */
export interface ReceiptProposal {
  readonly suggestionId: string;
  readonly description: ProposedValue<string> | null;
  readonly amountMinor: ProposedValue<number> | null;
  readonly currency: ProposedValue<string> | null;
  readonly incurredOn: ProposedValue<string> | null;
  /** NO_ANSWER fields and why, by field path. */
  readonly missing: Readonly<Record<string, string>>;
}

function proposed<T>(
  fields: readonly SuggestionField[],
  path: string,
  accept: (value: unknown) => T | null,
): ProposedValue<T> | null {
  const field = fields.find((f) => f.field_path === path);
  if (!field || field.refusal !== null) return null;
  const value = accept(field.proposed_value);
  return value === null ? null : { value, confidence: field.confidence ?? 0 };
}

/** Reads the receipt suggestion's fields (packages/ai EXTRACTION_TARGETS.receipt) into the form's terms. */
export function receiptProposal(
  suggestionId: string,
  fields: readonly SuggestionField[],
): ReceiptProposal {
  const missing: Record<string, string> = {};
  for (const f of fields) if (f.refusal === "NO_ANSWER") missing[f.field_path] = f.missing ?? "";
  return {
    suggestionId,
    description: proposed(fields, "description", (v) =>
      typeof v === "string" && v.trim() ? v.trim().slice(0, 500) : null,
    ),
    amountMinor: proposed(fields, "amount_minor", (v) => {
      const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
      return Number.isSafeInteger(n) && n > 0 ? n : null;
    }),
    currency: proposed(fields, "currency", (v) =>
      typeof v === "string" && /^[A-Z]{3}$/.test(v) ? v : null,
    ),
    incurredOn: proposed(fields, "incurred_on", (v) =>
      typeof v === "string" && isIsoDay(v) ? v : null,
    ),
    missing,
  };
}

/**
 * The form after Aurora read the receipt: each field it read fills an empty field, and the amount fills only when
 * the receipt is in the budget's currency (an expense is in its budget's currency and Compass converts nothing).
 */
export function applyProposal(
  draft: ExpenseDraft,
  proposal: ReceiptProposal,
  budgetCurrency: string | null,
): { readonly draft: ExpenseDraft; readonly otherCurrency: string | null } {
  const receiptCurrency = proposal.currency?.value ?? null;
  const otherCurrency =
    receiptCurrency && budgetCurrency && receiptCurrency !== budgetCurrency
      ? receiptCurrency
      : null;
  const amountCurrency = budgetCurrency ?? receiptCurrency;
  return {
    otherCurrency,
    draft: {
      ...draft,
      description: draft.description.trim()
        ? draft.description
        : (proposal.description?.value ?? ""),
      amount:
        draft.amount.trim() || !proposal.amountMinor || otherCurrency || !amountCurrency
          ? draft.amount
          : amountText(proposal.amountMinor.value, amountCurrency),
      incurredOn: proposal.incurredOn?.value ?? draft.incurredOn,
    },
  };
}

/** Why Aurora is not reading this receipt, for the line above the form. */
export type AuroraState =
  "reading" | "read" | "off" | "not-in-plan" | "limit" | "offline" | "no-answer" | "failed";

/** The calls reading a receipt needs from the Aurora client (@xos/ai/client), with the person's own token. */
export type ReceiptReader = Pick<AuroraClient, "status" | "extract" | "suggestion">;

export interface ReceiptReading {
  readonly state: Exclude<AuroraState, "reading">;
  readonly proposal: ReceiptProposal | null;
}

function refusalState(problem: AuroraProblem): Exclude<AuroraState, "reading" | "read"> {
  if (problem.status === 0) return "offline";
  if (problem.rule === "aurora_feature_off") return "off";
  if (problem.rule === "aurora_not_in_plan") return "not-in-plan";
  if (problem.rule === "plan_limit_exceeded") return "limit";
  return "failed";
}

/**
 * Reads a receipt with Aurora. The org's switch comes first: with document extraction off, not in the plan or the
 * allowance used, no photo leaves the phone. The server checks the same again (app.ai_begin_request) and the
 * screen says why when it refuses. Offline, nothing is tried: the person types the fields and the save queues.
 */
export async function readReceipt(
  reader: ReceiptReader,
  jpegBase64: string,
  online: boolean,
): Promise<ReceiptReading> {
  const none = (state: Exclude<AuroraState, "reading">): ReceiptReading => ({
    state,
    proposal: null,
  });
  if (!online) return none("offline");
  const status = await reader.status();
  if (!status.ok) return none(refusalState(status.problem));
  if (!status.data.plan_includes_aurora) return none("not-in-plan");
  if (!status.data.enabled_features.includes("extraction")) return none("off");
  if (status.data.allowance !== null && status.data.used >= status.data.allowance)
    return none("limit");
  const result = await reader.extract(receiptExtractionRequest(jpegBase64));
  if (!result.ok) return none(refusalState(result.problem));
  if (result.data.outcome === "no_answer") return none("no-answer");
  if (result.data.outcome !== "answer") return none("failed");
  const proposal = result.data.suggestions.find((s) => s.operation_id === "expenses.create");
  if (!proposal) return none("no-answer");
  const suggestion = await reader.suggestion(proposal.suggestion_id);
  if (!suggestion.ok) return none(refusalState(suggestion.problem));
  return {
    state: "read",
    proposal: receiptProposal(proposal.suggestion_id, suggestion.data.proposed_fields),
  };
}

// Saving ----------------------------------------------------------------------------------------------------------

export type CaptureSource = "Camera" | "Photo Library";

export interface ReceiptSave {
  readonly personId: string;
  readonly line: BudgetLineRow;
  readonly description: string;
  readonly amountMinor: number;
  readonly incurredOn: string;
  /** The compressed photo on the device. */
  readonly localUri: string;
  readonly captureSource: CaptureSource;
  readonly capturedAt: string | null;
  /** The Aurora suggestion whose fields the person confirmed, if Aurora read the receipt. */
  readonly suggestionId: string | null;
}

/** The field-media object a receipt photo is stored as: under the budget line's org and project (1490). */
export function receiptPath(
  line: Pick<BudgetLineRow, "org_id" | "project_id">,
  expenseId: string,
): string {
  return `${line.org_id}/expense-receipts/${line.project_id}/${expenseId}.jpg`;
}

/**
 * Queues the expense with its receipt. The uploader stores the photo (local_uri, storage_path) before it calls
 * app.submit_expense_receipt through app.apply_sync_mutation, so a replay files it once; the optimistic row shows
 * at once in the person's list.
 */
export function buildReceiptSave(
  save: ReceiptSave,
  nowMs: number,
  newId: (ms: number) => string = uuidv7,
): MutationInput {
  const id = newId(nowMs);
  const path = receiptPath(save.line, id);
  const description = save.description.trim();
  return {
    op: "rpc",
    target: "app.submit_expense_receipt",
    table: "expenses",
    rowId: id,
    payload: {
      p_id: id,
      p_budget_line_id: save.line.id,
      p_description: description,
      p_amount_minor: save.amountMinor,
      p_currency_code: save.line.currency_code,
      p_incurred_on: save.incurredOn,
      p_media_uri: path,
      p_capture_source: save.captureSource,
      p_captured_at: save.capturedAt,
      p_ai_suggestion_id: save.suggestionId,
      storage_path: path,
      local_uri: save.localUri,
    },
    policy: "append",
    optimistic: {
      id,
      org_id: save.line.org_id,
      budget_line_id: save.line.id,
      submitter_person_id: save.personId,
      description,
      incurred_on: save.incurredOn,
      amount_minor: save.amountMinor,
      currency_code: save.line.currency_code,
      expense_state: "Proposed",
      created_at: new Date(nowMs).toISOString(),
    },
  };
}

/** The person's own expenses, newest first by the day they were incurred. */
export function myExpenses(rows: readonly ExpenseRow[], personId: string | null): ExpenseRow[] {
  return rows
    .filter((r) => r.submitter_person_id === personId)
    .slice()
    .sort(
      (a, b) =>
        b.incurred_on.localeCompare(a.incurred_on) ||
        (b.created_at ?? "").localeCompare(a.created_at ?? ""),
    );
}
