import type { XosClient } from "./client.ts";
import type { DatabaseErrorLike } from "./result.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Public form links (B2, ADR 0141; migration 2916): a tokenised public mode for Published forms with no
 * photo, signature or GPS. A response is filed Submitted and becomes a record only when a member
 * approves it. The window plan below gives the page its steps; conditional fields mirror
 * private.form_field_shown so a window never holds more than gate 27's seven fields.
 */

export const FORM_LINK_TOKEN = /^xfrm_[0-9a-f]{64}$/;
export const FORM_LINK_GRANT = /^xfrg_[0-9a-f]{64}$/;
export const MAX_FORM_LINK_DAYS = 90;

export function formLinkPath(token: string): string {
  return `/forms/${token}`;
}

export const FORM_LINK_REFUSALS = [
  "form_link_invalid",
  "form_link_rate_limited",
  "form_link_expired",
  "form_link_locked",
  "form_link_access_code_required",
  "form_link_access_code",
  "form_link_grant",
  "form_link_too_fast",
  "form_link_already_answered",
  "form_answers_too_large",
  "form_not_published",
  "form_respondent_name",
  "form_respondent_email",
  "form_answers",
  "form_answer_hidden",
  "form_answer_required",
  "form_answer_type",
  "form_answer_choice",
  "form_answer_date",
  "form_answer_length",
  "org_read_only",
] as const;

export type FormLinkRefusal = (typeof FORM_LINK_REFUSALS)[number];

export function parseFormLinkRefusal(reason: unknown): FormLinkRefusal {
  return (FORM_LINK_REFUSALS as readonly unknown[]).includes(reason)
    ? (reason as FormLinkRefusal)
    : "form_link_invalid";
}

export function formLinkAsksForCode(reason: FormLinkRefusal): boolean {
  return (
    reason === "form_link_grant" ||
    reason === "form_link_access_code_required" ||
    reason === "form_link_access_code"
  );
}

export type FormLinkRefused = { readonly refused: true; readonly reason: FormLinkRefusal };

// Managing links (signed in) -----------------------------------------------------------------------

export interface CreatedFormLink {
  readonly id: string;
  readonly token: string;
  readonly accessCode: string;
  readonly expiresAt: string;
}

export async function createFormLink(
  db: XosClient,
  input: {
    readonly templateId: string;
    readonly expiresAt: string;
    readonly projectId: string | null;
    readonly dailyCap: number;
    readonly maxResponses: number | null;
    readonly onePerEmail: boolean;
    readonly note: string | null;
  },
): Promise<Result<CreatedFormLink>> {
  const { data, error } = await db.rpc("create_form_link", {
    p_template_id: input.templateId,
    p_expires_at: input.expiresAt,
    ...(input.projectId === null ? {} : { p_project_id: input.projectId }),
    p_daily_cap: input.dailyCap,
    ...(input.maxResponses === null ? {} : { p_max_responses: input.maxResponses }),
    p_one_per_email: input.onePerEmail,
    ...(input.note === null ? {} : { p_note: input.note }),
  });
  if (error) return fail(toDataError(error));
  const row = (Array.isArray(data) ? data[0] : null) as {
    form_link_id: string;
    token: string | null;
    access_code: string | null;
    expires_at: string;
  } | null;
  if (!row?.token || !row.access_code) {
    return fail({ kind: "unexpected", message: "create_form_link returned no token" });
  }
  return ok({
    id: row.form_link_id,
    token: row.token,
    accessCode: row.access_code,
    expiresAt: row.expires_at,
  });
}

export async function regenerateFormLink(
  db: XosClient,
  id: string,
): Promise<Result<Omit<CreatedFormLink, "id">>> {
  const { data, error } = await db.rpc("regenerate_form_link", { p_id: id });
  if (error) return fail(toDataError(error));
  const row = (Array.isArray(data) ? data[0] : null) as {
    token: string | null;
    access_code: string | null;
    expires_at: string;
  } | null;
  if (!row?.token || !row.access_code) {
    return fail({ kind: "unexpected", message: "regenerate_form_link returned no token" });
  }
  return ok({ token: row.token, accessCode: row.access_code, expiresAt: row.expires_at });
}

export async function revokeFormLink(db: XosClient, id: string): Promise<Result<string>> {
  const { data, error } = await db.rpc("revoke_form_link", { p_id: id });
  if (error) return fail(toDataError(error));
  return ok(String(data));
}

// The anonymous side ---------------------------------------------------------------------------------

type PublicRpc = {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: DatabaseErrorLike | null }>;
};

function publicRpc(db: XosClient): PublicRpc {
  return (db as unknown as { schema(name: "api_public"): PublicRpc }).schema("api_public");
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

export async function openFormLink(
  db: XosClient,
  input: {
    readonly token: string;
    readonly accessCode: string | null;
    readonly clientAddress: string | null;
  },
): Promise<
  Result<
    | { readonly refused: false; readonly grant: string; readonly grantExpiresAt: string }
    | FormLinkRefused
  >
> {
  if (!FORM_LINK_TOKEN.test(input.token)) return ok({ refused: true, reason: "form_link_invalid" });
  const { data, error } = await publicRpc(db).rpc("open_form_link", {
    p_token: input.token,
    p_access_code: input.accessCode,
    p_client_address: input.clientAddress,
  });
  if (error) return fail(toDataError(error));
  const body = (data ?? {}) as Record<string, unknown>;
  if (body["status"] !== "ok" || typeof body["grant"] !== "string") {
    return ok({ refused: true, reason: parseFormLinkRefusal(body["reason"]) });
  }
  return ok({
    refused: false,
    grant: body["grant"],
    grantExpiresAt: str(body["grant_expires_at"]),
  });
}

export interface PublicFormField {
  readonly key: string;
  readonly label: string;
  readonly kind: string;
  readonly required: boolean;
  readonly choices: readonly string[] | null;
  readonly showIf: { readonly key: string; readonly equals?: unknown } | null;
}

export interface PublicForm {
  readonly refused: false;
  readonly brandName: string;
  readonly brandAccentHex: string | null;
  readonly suppressPoweredBy: boolean;
  readonly expiresAt: string;
  readonly name: string;
  readonly description: string | null;
  readonly fields: readonly PublicFormField[];
}

export async function readPublicForm(
  db: XosClient,
  input: {
    readonly token: string;
    readonly grant: string;
    readonly clientAddress: string | null;
  },
): Promise<Result<PublicForm | FormLinkRefused>> {
  if (!FORM_LINK_TOKEN.test(input.token)) return ok({ refused: true, reason: "form_link_invalid" });
  const { data, error } = await publicRpc(db).rpc("public_form", {
    p_token: input.token,
    p_grant: input.grant,
    p_client_address: input.clientAddress,
  });
  if (error) return fail(toDataError(error));
  const b = (data ?? {}) as Record<string, unknown>;
  if (b["status"] !== "ok") return ok({ refused: true, reason: parseFormLinkRefusal(b["reason"]) });
  const m = (b["meta"] ?? {}) as Record<string, unknown>;
  const fields = (Array.isArray(b["fields"]) ? b["fields"] : []) as Record<string, unknown>[];
  return ok({
    refused: false,
    brandName: str(m["brand_name"]),
    brandAccentHex: strOrNull(m["brand_accent_hex"]),
    suppressPoweredBy: m["brand_suppress_powered_by"] === true,
    expiresAt: str(m["expires_at"]),
    name: str(b["name"]),
    description: strOrNull(b["description"]),
    fields: fields.map((f) => ({
      key: str(f["key"]),
      label: str(f["label"]),
      kind: str(f["kind"]),
      required: f["required"] === true,
      choices: Array.isArray(f["choices"]) ? (f["choices"] as string[]) : null,
      showIf: (f["show_if"] as PublicFormField["showIf"]) ?? null,
    })),
  });
}

export async function submitPublicForm(
  db: XosClient,
  input: {
    readonly token: string;
    readonly grant: string;
    readonly name: string;
    readonly email: string;
    readonly answers: Readonly<Record<string, unknown>>;
    readonly website: string;
    readonly clientAddress: string | null;
  },
): Promise<Result<{ readonly refused: false } | FormLinkRefused>> {
  if (!FORM_LINK_TOKEN.test(input.token)) return ok({ refused: true, reason: "form_link_invalid" });
  const { data, error } = await publicRpc(db).rpc("submit_public_form", {
    p_token: input.token,
    p_grant: input.grant,
    p_respondent_name: input.name,
    p_respondent_email: input.email,
    p_answers: input.answers,
    p_website: input.website === "" ? null : input.website,
    p_client_address: input.clientAddress,
  });
  if (error) return fail(toDataError(error));
  const body = (data ?? {}) as Record<string, unknown>;
  if (body["status"] !== "ok") {
    return ok({ refused: true, reason: parseFormLinkRefusal(body["reason"]) });
  }
  return ok({ refused: false });
}

// The form's windows -----------------------------------------------------------------------------------

/** The first window also holds name and email (two fields), so it takes five form fields. */
export const FIRST_WINDOW_FIELDS = 5;
export const WINDOW_FIELDS = 7;

function sameAnswer(answer: unknown, expected: unknown): boolean {
  return JSON.stringify(answer) === JSON.stringify(expected);
}

/** Whether a field shows, as private.form_field_shown (0803) decides it. */
export function formFieldShown(
  field: PublicFormField,
  answers: Readonly<Record<string, unknown>>,
): boolean {
  const condition = field.showIf;
  if (condition === null) return true;
  const answer = answers[condition.key];
  if (sameAnswer(answer, condition.equals)) return true;
  return Array.isArray(answer) && answer.some((a) => sameAnswer(a, condition.equals));
}

/**
 * The answers that still count: those of fields that show. Answers stay in client state when a field hides, so going
 * back and changing an earlier answer can leave a stale one behind, and a field depending on it would show here while
 * the server, which sees only what is sent, refuses it as form_answer_hidden. So a field shows only through answers
 * that count, worked out until nothing changes, since a rule may name any field.
 */
export function liveFormAnswers(
  fields: readonly PublicFormField[],
  answers: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  let live: Record<string, unknown> = { ...answers };
  for (let pass = 0; pass <= fields.length; pass += 1) {
    const next: Record<string, unknown> = {};
    for (const field of fields) {
      if (formFieldShown(field, live) && answers[field.key] !== undefined) {
        next[field.key] = answers[field.key];
      }
    }
    if (Object.keys(next).length === Object.keys(live).length) return next;
    live = next;
  }
  return live;
}

/** The shown fields in windows: 5 in the first (beside name and email), then 7 each. */
export function planFormWindows(
  fields: readonly PublicFormField[],
  answers: Readonly<Record<string, unknown>>,
): readonly (readonly PublicFormField[])[] {
  const live = liveFormAnswers(fields, answers);
  const shown = fields.filter((f) => formFieldShown(f, live));
  const windows: PublicFormField[][] = [shown.slice(0, FIRST_WINDOW_FIELDS)];
  for (let i = FIRST_WINDOW_FIELDS; i < shown.length; i += WINDOW_FIELDS) {
    windows.push(shown.slice(i, i + WINDOW_FIELDS));
  }
  return windows;
}
