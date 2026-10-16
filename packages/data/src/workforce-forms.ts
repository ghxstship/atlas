import type { XosClient } from "./client.ts";
import { fail, type Result } from "./result.ts";
import { untyped } from "./untyped.ts";
import {
  args,
  callId,
  call,
  memberName,
  MEMBER_EMBED,
  num,
  numOrNull,
  rows,
  single,
  str,
  strOrNull,
  bool,
  type Raw,
} from "./workforce-shared.ts";

/**
 * The no-code form builder (Section 4.9 Forms; migration 0803), imported as
 * `@xos/data/workforce-forms`. Templates are drafted with knowledge.sop.write and published or
 * retired with knowledge.sop.publish; each publish snapshots a version. Submissions go through
 * app.submit_form, which checks conditions, required photos, GPS and signature, scores the answers,
 * makes a record of the template's canon kind on a project and routes it to the approver role.
 */

export type FormFieldKind =
  "text" | "long_text" | "number" | "yes_no" | "choice" | "multi_choice" | "date" | "photo";
export type FormTemplateState = "Draft" | "Published" | "Retired";
export type FormSubmissionState = "Submitted" | "Approved" | "Rejected" | "Recorded";

export const FORM_FIELD_KINDS: readonly FormFieldKind[] = [
  "text",
  "long_text",
  "number",
  "yes_no",
  "choice",
  "multi_choice",
  "date",
  "photo",
];

export interface FormField {
  readonly key: string;
  readonly label: string;
  readonly kind: FormFieldKind;
  readonly required?: boolean;
  readonly choices?: readonly string[];
  readonly points?: Readonly<Record<string, number>>;
  readonly show_if?: { readonly key: string; readonly equals: string | number | boolean };
}

export type FormAnswer = string | number | boolean | readonly string[];
export type FormAnswers = Readonly<Record<string, FormAnswer>>;

export interface FormTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly recordKind: string;
  readonly recordSubtype: string | null;
  readonly fields: readonly FormField[];
  readonly requiresSignature: boolean;
  readonly requiresLocation: boolean;
  readonly passScore: number | null;
  readonly approverRoleId: string | null;
  readonly state: FormTemplateState;
  readonly version: number;
  readonly updatedAt: string;
}

function toTemplate(r: Raw): FormTemplate {
  return {
    id: str(r["id"]),
    name: str(r["name"]),
    description: strOrNull(r["description"]),
    recordKind: str(r["record_kind"]),
    recordSubtype: strOrNull(r["record_subtype"]),
    fields: (Array.isArray(r["fields"]) ? r["fields"] : []) as FormField[],
    requiresSignature: bool(r["requires_signature"]),
    requiresLocation: bool(r["requires_location"]),
    passScore: numOrNull(r["pass_score"]),
    approverRoleId: strOrNull(r["approver_role_id"]),
    state: str(r["template_state"]) as FormTemplateState,
    version: num(r["current_version"]),
    updatedAt: str(r["updated_at"]),
  };
}

const TEMPLATE_COLUMNS =
  "id, name, description, record_kind, record_subtype, fields, requires_signature, requires_location, pass_score, approver_role_id, template_state, current_version, updated_at";

export async function listFormTemplates(
  db: XosClient,
  orgId: string,
): Promise<Result<FormTemplate[]>> {
  return rows(
    untyped(db)
      .from("form_templates")
      .select(TEMPLATE_COLUMNS)
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .order("name"),
    toTemplate,
  );
}

export async function getFormTemplate(db: XosClient, id: string): Promise<Result<FormTemplate>> {
  return single(
    untyped(db).from("form_templates").select(TEMPLATE_COLUMNS).eq("id", id).maybeSingle(),
    toTemplate,
  );
}

/** Problems in a field list, as the database would refuse them, for the builder to explain. */
export function formFieldProblems(fields: readonly FormField[]): string[] {
  const problems: string[] = [];
  if (fields.length === 0 || fields.length > 100) problems.push("fieldCount");
  const seen: string[] = [];
  fields.forEach((f, i) => {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(f.key)) problems.push(`key:${i}`);
    else if (seen.includes(f.key)) problems.push(`duplicate:${i}`);
    if (f.label.trim() === "" || f.label.length > 200) problems.push(`label:${i}`);
    if (
      (f.kind === "choice" || f.kind === "multi_choice") &&
      ((f.choices?.length ?? 0) < 2 || (f.choices?.length ?? 0) > 30)
    ) {
      problems.push(`choices:${i}`);
    }
    if (f.show_if && !seen.includes(f.show_if.key)) problems.push(`condition:${i}`);
    seen.push(f.key);
  });
  return problems;
}

/** A field key from its label: lowercase letters, digits and underscores, unique among `taken`. */
export function fieldKey(label: string, taken: readonly string[]): string {
  const base =
    label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^([0-9])/, "f_$1")
      .slice(0, 32) || "field";
  let key = base;
  for (let n = 2; taken.includes(key); n += 1) key = `${base}_${n}`;
  return key;
}

export interface FormTemplateInput {
  readonly name: string;
  readonly description?: string | null;
  readonly recordKind: string;
  readonly recordSubtype?: string | null;
  readonly fields: readonly FormField[];
  readonly requiresSignature?: boolean;
  readonly requiresLocation?: boolean;
  readonly passScore?: number | null;
  readonly approverRoleId?: string | null;
}

function templateColumns(input: FormTemplateInput): Raw {
  return {
    name: input.name,
    description: input.description ?? null,
    record_kind: input.recordKind,
    record_subtype: input.recordSubtype ?? null,
    fields: input.fields,
    requires_signature: input.requiresSignature ?? false,
    requires_location: input.requiresLocation ?? false,
    pass_score: input.passScore ?? null,
    approver_role_id: input.approverRoleId ?? null,
  };
}

export async function createFormTemplate(
  db: XosClient,
  orgId: string,
  input: FormTemplateInput,
): Promise<Result<{ id: string }>> {
  if (formFieldProblems(input.fields).length > 0)
    return fail({ kind: "invalid", message: formFieldProblems(input.fields).join(",") });
  return single(
    untyped(db)
      .from("form_templates")
      .insert({ org_id: orgId, ...templateColumns(input) })
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

/** Edits a draft template. */
export async function updateFormTemplate(
  db: XosClient,
  id: string,
  input: FormTemplateInput,
): Promise<Result<{ id: string }>> {
  if (formFieldProblems(input.fields).length > 0)
    return fail({ kind: "invalid", message: formFieldProblems(input.fields).join(",") });
  return single(
    untyped(db)
      .from("form_templates")
      .update(templateColumns(input))
      .eq("id", id)
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

export async function publishFormTemplate(db: XosClient, id: string): Promise<Result<number>> {
  return call<number>(db, "publish_form_template", { p_template_id: id });
}

export async function retireFormTemplate(
  db: XosClient,
  id: string,
  reason: string,
): Promise<Result<{ id: string }>> {
  return callId(db, "retire_form_template", { p_template_id: id, p_reason: reason });
}

/** Whether a field shows given the answers so far (mirrors private.form_field_shown). */
export function fieldShown(field: FormField, answers: FormAnswers): boolean {
  if (!field.show_if) return true;
  const answer = answers[field.show_if.key];
  if (Array.isArray(answer)) return answer.includes(String(field.show_if.equals));
  return answer === field.show_if.equals;
}

/** Points available and earned on the shown, scored fields; null when nothing is scored. */
export function formScore(
  fields: readonly FormField[],
  answers: FormAnswers,
): { score: number; max: number } | null {
  let score = 0;
  let max = 0;
  let scored = false;
  for (const f of fields) {
    if (!f.points || !fieldShown(f, answers)) continue;
    scored = true;
    const values = Object.values(f.points);
    max += values.length > 0 ? Math.max(...values) : 0;
    const a = answers[f.key];
    if (Array.isArray(a)) for (const c of a) score += f.points[c] ?? 0;
    else if (a !== undefined) score += f.points[String(a)] ?? 0;
  }
  return scored ? { score, max } : null;
}

/** Required shown fields still unanswered, by key. */
export function missingAnswers(fields: readonly FormField[], answers: FormAnswers): string[] {
  return fields
    .filter((f) => f.required && fieldShown(f, answers))
    .filter((f) => {
      const a = answers[f.key];
      return a === undefined || a === "" || (Array.isArray(a) && a.length === 0);
    })
    .map((f) => f.key);
}

export interface FormSubmissionInput {
  readonly answers: FormAnswers;
  readonly projectId?: string | null;
  readonly location?: {
    readonly latitude: number;
    readonly longitude: number;
    readonly accuracyM?: number;
  } | null;
  readonly signature?: { readonly signerName: string; readonly signaturePath: string } | null;
}

export async function submitForm(
  db: XosClient,
  templateId: string,
  input: FormSubmissionInput,
): Promise<Result<{ id: string }>> {
  return callId(db, "submit_form", {
    p_template_id: templateId,
    p_answers: input.answers,
    ...args({
      p_project_id: input.projectId ?? undefined,
      p_location: input.location
        ? args({
            latitude: input.location.latitude,
            longitude: input.location.longitude,
            accuracy_m: input.location.accuracyM,
          })
        : undefined,
      p_signature: input.signature
        ? { signer_name: input.signature.signerName, signature_path: input.signature.signaturePath }
        : undefined,
    }),
  });
}

export interface FormSubmission {
  readonly id: string;
  readonly templateId: string;
  readonly templateName: string | null;
  readonly version: number | null;
  readonly projectId: string | null;
  readonly recordId: string | null;
  readonly submittedByMembershipId: string;
  readonly submittedByName: string | null;
  readonly answers: FormAnswers;
  readonly score: number | null;
  readonly maxScore: number | null;
  readonly passed: boolean | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly signerName: string | null;
  readonly signedAt: string | null;
  readonly state: FormSubmissionState;
  readonly decisionNote: string | null;
  readonly createdAt: string;
}

export async function listFormSubmissions(
  db: XosClient,
  orgId: string,
  options: { readonly templateId?: string } = {},
): Promise<Result<FormSubmission[]>> {
  let query = untyped(db)
    .from("form_submissions")
    .select(
      `id, form_template_id, project_id, record_id, submitted_by_membership_id, answers, score, max_score, passed, latitude, longitude,
       signer_name, signed_at, submission_state, decision_note, created_at, template:form_templates(name),
       version:form_template_versions(version), submitter:memberships!form_submissions_submitted_by_membership_id_fkey(${MEMBER_EMBED})`,
    )
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (options.templateId) query = query.eq("form_template_id", options.templateId);
  return rows(query, (r) => ({
    id: str(r["id"]),
    templateId: str(r["form_template_id"]),
    templateName: strOrNull((r["template"] as Raw | null)?.["name"]),
    version: numOrNull((r["version"] as Raw | null)?.["version"]),
    projectId: strOrNull(r["project_id"]),
    recordId: strOrNull(r["record_id"]),
    submittedByMembershipId: str(r["submitted_by_membership_id"]),
    submittedByName: memberName(r["submitter"]),
    answers: (r["answers"] as FormAnswers | null) ?? {},
    score: numOrNull(r["score"]),
    maxScore: numOrNull(r["max_score"]),
    passed: typeof r["passed"] === "boolean" ? r["passed"] : null,
    latitude: numOrNull(r["latitude"]),
    longitude: numOrNull(r["longitude"]),
    signerName: strOrNull(r["signer_name"]),
    signedAt: strOrNull(r["signed_at"]),
    state: str(r["submission_state"]) as FormSubmissionState,
    decisionNote: strOrNull(r["decision_note"]),
    createdAt: str(r["created_at"]),
  }));
}

export async function decideFormSubmission(
  db: XosClient,
  id: string,
  approve: boolean,
  note?: string | null,
): Promise<Result<{ id: string }>> {
  return callId(
    db,
    "decide_form_submission",
    args({ p_submission_id: id, p_approve: approve, p_note: note ?? undefined }),
  );
}

export interface RecordKindOption {
  readonly kind: string;
  readonly subtypes: readonly string[];
}

/** Canon record kinds with their subtypes, for the template's record kind picker. */
export async function listRecordKindOptions(db: XosClient): Promise<Result<RecordKindOption[]>> {
  const [kinds, subtypes] = await Promise.all([
    rows(
      db.schema("xpms").from("dim_record_kind").select("record_kind, ordinal").order("ordinal"),
      (r) => str(r["record_kind"]),
    ),
    rows(
      db.schema("xpms").from("dim_record_subtype").select("record_kind, record_subtype"),
      (r) => ({
        kind: str(r["record_kind"]),
        subtype: str(r["record_subtype"]),
      }),
    ),
  ]);
  if (!kinds.ok) return kinds;
  if (!subtypes.ok) return subtypes;
  return {
    ok: true,
    data: kinds.data.map((kind) => ({
      kind,
      subtypes: subtypes.data.filter((s) => s.kind === kind).map((s) => s.subtype),
    })),
  };
}
