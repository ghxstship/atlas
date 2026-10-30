import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type DatabaseErrorLike, type Result } from "./result.ts";
import { untyped } from "./untyped.ts";

/**
 * Platform workflow (A33, migrations 1030 to 1034): approval policies and approvals of spend
 * documents, Trash, project templates and org state labels; P9 (2860 to 2862) adds approval rules for passes,
 * deliveries and equipment, their computed approvals, and approval reminders. Every read and write runs as the
 * caller, so row level security and the RPCs decide; refusals come back typed with their rule.
 */

type Raw = Record<string, unknown>;

async function rows(
  query: PromiseLike<{ data: unknown; error: DatabaseErrorLike | null }>,
): Promise<Result<Raw[]>> {
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok((data as Raw[] | null) ?? []);
}

async function call<T>(
  db: XosClient,
  fn: string,
  args: Raw,
  map: (data: unknown) => T,
): Promise<Result<T>> {
  const { data, error } = await untyped(db).rpc(fn, args);
  if (error) return fail(toDataError(error));
  return ok(map(data));
}

async function write(
  query: PromiseLike<{ data: unknown; error: DatabaseErrorLike | null }>,
): Promise<Result<string>> {
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  const row = (Array.isArray(data) ? data[0] : data) as Raw | null;
  if (!row) return fail({ kind: "not-found" });
  return ok(str(row["id"]));
}

const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : typeof v === "number" ? v : Number(v);
const obj = (v: unknown): Raw | null =>
  Array.isArray(v) ? ((v[0] as Raw | undefined) ?? null) : ((v as Raw | null) ?? null);
const now = () => new Date().toISOString();

// Approval policies -------------------------------------------------------------------------------------

export const APPROVAL_DOCUMENT_TYPES = [
  "Purchase Order",
  "Change Order",
  "Expense",
  "Invoice Approval",
  "Payroll Run",
  "Requisition",
] as const;
export type ApprovalDocumentType = (typeof APPROVAL_DOCUMENT_TYPES)[number];

export type PolicyState = "Draft" | "Active" | "Retired";
export type ApprovalState = "In Review" | "Approved" | "Rejected" | "Canceled";

export interface ApprovalStep {
  readonly id: string;
  readonly order: number;
  readonly name: string;
  readonly roleId: string | null;
  readonly membershipId: string | null;
}

export interface ApprovalPolicy {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly documentType: ApprovalDocumentType;
  readonly currency: string | null;
  readonly appliesAboveMinor: number | null;
  readonly state: PolicyState;
  readonly steps: readonly ApprovalStep[];
  readonly updatedAt: string;
}

/** The org's approval policies with their steps, Active first. */
export async function listApprovalPolicies(
  db: XosClient,
  orgId: string,
): Promise<Result<ApprovalPolicy[]>> {
  const [policies, steps] = await Promise.all([
    rows(
      untyped(db)
        .from("approval_policies")
        .select(
          "id, name, description, document_type, currency_code, applies_above_minor, policy_state, updated_at",
        )
        .eq("org_id", orgId)
        .is("deleted_at", null)
        .order("name"),
    ),
    rows(
      untyped(db)
        .from("approval_steps")
        .select(
          "id, approval_policy_id, step_order, name, approver_role_id, approver_membership_id",
        )
        .eq("org_id", orgId)
        .is("deleted_at", null)
        .order("step_order"),
    ),
  ]);
  if (!policies.ok) return policies;
  if (!steps.ok) return steps;
  const rank: Record<string, number> = { Active: 0, Draft: 1, Retired: 2 };
  return ok(
    policies.data
      .map((p) => ({
        id: str(p["id"]),
        name: str(p["name"]),
        description: strOrNull(p["description"]),
        documentType: str(p["document_type"]) as ApprovalDocumentType,
        currency: strOrNull(p["currency_code"])?.trim() ?? null,
        appliesAboveMinor: numOrNull(p["applies_above_minor"]),
        state: str(p["policy_state"]) as PolicyState,
        updatedAt: str(p["updated_at"]),
        steps: steps.data
          .filter((s) => str(s["approval_policy_id"]) === str(p["id"]))
          .map((s) => ({
            id: str(s["id"]),
            order: num(s["step_order"]),
            name: str(s["name"]),
            roleId: strOrNull(s["approver_role_id"]),
            membershipId: strOrNull(s["approver_membership_id"]),
          })),
      }))
      .sort((a, b) => (rank[a.state] ?? 3) - (rank[b.state] ?? 3) || a.name.localeCompare(b.name)),
  );
}

export interface PolicyInput {
  readonly orgId: string;
  readonly name: string;
  readonly description: string | null;
  readonly documentType: ApprovalDocumentType;
  readonly currency: string | null;
  readonly appliesAboveMinor: number | null;
}

export async function createApprovalPolicy(
  db: XosClient,
  input: PolicyInput,
): Promise<Result<string>> {
  return write(
    untyped(db)
      .from("approval_policies")
      .insert({
        org_id: input.orgId,
        name: input.name.trim(),
        description: input.description,
        document_type: input.documentType,
        currency_code: input.appliesAboveMinor === null ? null : input.currency,
        applies_above_minor: input.appliesAboveMinor,
      })
      .select("id")
      .single(),
  );
}

export async function deleteApprovalPolicy(db: XosClient, id: string): Promise<Result<string>> {
  return write(
    untyped(db).from("approval_policies").update({ deleted_at: now() }).eq("id", id).select("id"),
  );
}

export async function addApprovalStep(
  db: XosClient,
  input: {
    readonly policyId: string;
    readonly name: string;
    readonly roleId: string | null;
    readonly membershipId: string | null;
  },
): Promise<Result<string>> {
  const last = await rows(
    untyped(db)
      .from("approval_steps")
      .select("step_order")
      .eq("approval_policy_id", input.policyId)
      .is("deleted_at", null)
      .order("step_order", { ascending: false })
      .limit(1),
  );
  if (!last.ok) return last;
  return write(
    untyped(db)
      .from("approval_steps")
      .insert({
        approval_policy_id: input.policyId,
        step_order: num(last.data[0]?.["step_order"]) + 1,
        name: input.name.trim(),
        approver_role_id: input.roleId,
        approver_membership_id: input.membershipId,
      })
      .select("id")
      .single(),
  );
}

export async function removeApprovalStep(db: XosClient, id: string): Promise<Result<string>> {
  return write(
    untyped(db).from("approval_steps").update({ deleted_at: now() }).eq("id", id).select("id"),
  );
}

export async function transitionApprovalPolicy(
  db: XosClient,
  input: {
    readonly id: string;
    readonly from: PolicyState;
    readonly to: PolicyState;
    readonly reason: string;
  },
): Promise<Result<string>> {
  return call(
    db,
    "transition_approval_policy",
    {
      p_approval_policy_id: input.id,
      p_expected: input.from,
      p_next: input.to,
      p_reason: input.reason,
    },
    str,
  );
}

// Approvals -----------------------------------------------------------------------------------------------

export interface ApprovalDecision {
  readonly id: string;
  readonly step: number;
  readonly approverId: string;
  readonly approverName: string | null;
  readonly approved: boolean;
  readonly comment: string | null;
  readonly decidedAt: string;
}

export interface Approval {
  readonly id: string;
  readonly policyId: string;
  readonly policyName: string;
  readonly documentType: ApprovalDocumentType;
  readonly documentId: string;
  readonly subjectTable: string;
  readonly subjectReference: string | null;
  readonly projectId: string | null;
  readonly amountMinor: number;
  readonly currency: string;
  readonly requestedBy: string;
  readonly requesterName: string | null;
  readonly state: ApprovalState;
  readonly currentStep: number;
  readonly decidedAt: string | null;
  readonly createdAt: string;
  readonly decisions: readonly ApprovalDecision[];
}

/** Approvals the viewer may read (requester, approvers and policy administrators), newest first. */
export async function listApprovals(db: XosClient, orgId: string): Promise<Result<Approval[]>> {
  const instances = await rows(
    untyped(db)
      .from("approval_instances")
      .select(
        "id, approval_policy_id, document_type, document_id, subject_table, subject_reference, project_id, amount_minor, currency_code, requested_by, approval_state, current_step, decided_at, created_at, policy:approval_policies(name), requester:people!approval_instances_requested_by_fkey(full_name)",
      )
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(200),
  );
  if (!instances.ok) return instances;
  const ids = instances.data.map((i) => str(i["id"]));
  const decisions =
    ids.length === 0
      ? ok([] as Raw[])
      : await rows(
          untyped(db)
            .from("approval_decisions")
            .select(
              "id, approval_instance_id, step_order, approver_id, approved, comment, decided_at, approver:people!approval_decisions_approver_id_fkey(full_name)",
            )
            .in("approval_instance_id", ids)
            .order("step_order"),
        );
  if (!decisions.ok) return decisions;
  return ok(
    instances.data.map((i) => ({
      id: str(i["id"]),
      policyId: str(i["approval_policy_id"]),
      policyName: str(obj(i["policy"])?.["name"]),
      documentType: str(i["document_type"]) as ApprovalDocumentType,
      documentId: str(i["document_id"]),
      subjectTable: str(i["subject_table"]),
      subjectReference: strOrNull(i["subject_reference"]),
      projectId: strOrNull(i["project_id"]),
      amountMinor: num(i["amount_minor"]),
      currency: str(i["currency_code"]).trim(),
      requestedBy: str(i["requested_by"]),
      requesterName: strOrNull(obj(i["requester"])?.["full_name"]),
      state: str(i["approval_state"]) as ApprovalState,
      currentStep: num(i["current_step"]),
      decidedAt: strOrNull(i["decided_at"]),
      createdAt: str(i["created_at"]),
      decisions: decisions.data
        .filter((d) => str(d["approval_instance_id"]) === str(i["id"]))
        .map((d) => ({
          id: str(d["id"]),
          step: num(d["step_order"]),
          approverId: str(d["approver_id"]),
          approverName: strOrNull(obj(d["approver"])?.["full_name"]),
          approved: d["approved"] === true,
          comment: strOrNull(d["comment"]),
          decidedAt: str(d["decided_at"]),
        })),
    })),
  );
}

/**
 * Whether the viewer may decide the step an approval waits on: they hold the step's role or are its
 * member, are not the requester and have not decided another step. The database checks the same
 * rules, plus the document's approval capability, when they decide.
 */
export function canDecide(
  approval: Approval,
  policy: ApprovalPolicy | undefined,
  viewer: {
    readonly personId: string;
    readonly membershipId: string;
    readonly roleIds: readonly string[];
  },
): boolean {
  if (approval.state !== "In Review" || approval.requestedBy === viewer.personId) return false;
  if (approval.decisions.some((d) => d.approverId === viewer.personId)) return false;
  const step = policy?.steps.find((s) => s.order === approval.currentStep);
  if (!step) return false;
  return (
    step.membershipId === viewer.membershipId ||
    (step.roleId !== null && viewer.roleIds.includes(step.roleId))
  );
}

export async function requestApproval(
  db: XosClient,
  input: { readonly documentType: ApprovalDocumentType; readonly documentId: string },
): Promise<Result<string>> {
  return call(
    db,
    "request_approval",
    { p_document_type: input.documentType, p_document_id: input.documentId },
    str,
  );
}

export async function decideApproval(
  db: XosClient,
  input: { readonly id: string; readonly approved: boolean; readonly comment: string | null },
): Promise<Result<string>> {
  return call(
    db,
    "decide_approval",
    { p_approval_instance_id: input.id, p_approved: input.approved, p_comment: input.comment },
    str,
  );
}

export async function cancelApproval(
  db: XosClient,
  input: { readonly id: string; readonly reason: string },
): Promise<Result<string>> {
  return call(
    db,
    "cancel_approval",
    { p_approval_instance_id: input.id, p_reason: input.reason },
    str,
  );
}

export interface SpendDocument {
  readonly documentType: ApprovalDocumentType;
  readonly id: string;
  readonly reference: string;
  readonly projectId: string | null;
}

/**
 * Spend documents the viewer can see that wait for approval: Proposed purchase orders, PO change
 * orders, requisitions and expenses, Priced change orders, Proposed or Disputed payable invoices and
 * Calculated payroll runs. Only types an Active policy gates are listed.
 */
export async function listDocumentsAwaitingApproval(
  db: XosClient,
  input: { readonly orgId: string; readonly types: readonly ApprovalDocumentType[] },
): Promise<Result<SpendDocument[]>> {
  const want = new Set(input.types);
  const out: SpendDocument[] = [];
  const add = async (
    type: ApprovalDocumentType,
    query: PromiseLike<{ data: unknown; error: DatabaseErrorLike | null }>,
    map: (r: Raw) => { id: string; reference: string; projectId: string | null },
  ): Promise<Result<null>> => {
    if (!want.has(type)) return ok(null);
    const result = await rows(query);
    if (!result.ok) return result;
    for (const r of result.data) out.push({ documentType: type, ...map(r) });
    return ok(null);
  };
  const u = untyped(db);
  const steps = await Promise.all([
    add(
      "Purchase Order",
      u
        .from("purchase_orders")
        .select("id, po_number, project_id, project:projects(project_key)")
        .eq("org_id", input.orgId)
        .eq("po_state", "Proposed")
        .is("deleted_at", null)
        .order("po_number")
        .limit(100),
      (r) => ({
        id: str(r["id"]),
        reference: `${str(obj(r["project"])?.["project_key"])} PO ${str(r["po_number"])}`,
        projectId: strOrNull(r["project_id"]),
      }),
    ),
    add(
      "Purchase Order",
      u
        .from("po_change_orders")
        .select("id, description, purchase_order:purchase_orders(po_number, project_id)")
        .eq("org_id", input.orgId)
        .eq("po_change_order_state", "Proposed")
        .is("deleted_at", null)
        .limit(100),
      (r) => ({
        id: str(r["id"]),
        reference: `PO ${str(obj(r["purchase_order"])?.["po_number"])}: ${str(r["description"])}`,
        projectId: strOrNull(obj(r["purchase_order"])?.["project_id"]),
      }),
    ),
    add(
      "Change Order",
      u
        .from("change_orders")
        .select("id, change_order_number, title, project_id")
        .eq("org_id", input.orgId)
        .eq("change_order_state", "Priced")
        .is("deleted_at", null)
        .limit(100),
      (r) => ({
        id: str(r["id"]),
        reference: `${str(r["change_order_number"])}: ${str(r["title"])}`,
        projectId: strOrNull(r["project_id"]),
      }),
    ),
    add(
      "Invoice Approval",
      u
        .from("invoices")
        .select("id, invoice_number, project_id")
        .eq("org_id", input.orgId)
        .eq("direction", "Payable")
        .in("invoice_state", ["Proposed", "Disputed"])
        .is("deleted_at", null)
        .limit(100),
      (r) => ({
        id: str(r["id"]),
        reference: str(r["invoice_number"]),
        projectId: strOrNull(r["project_id"]),
      }),
    ),
    add(
      "Requisition",
      u
        .from("requisitions")
        .select("id, role_code, headcount, project_id")
        .eq("org_id", input.orgId)
        .eq("requisition_state", "Proposed")
        .is("deleted_at", null)
        .limit(100),
      (r) => ({
        id: str(r["id"]),
        reference: `${str(r["role_code"])} × ${str(r["headcount"])}`,
        projectId: strOrNull(r["project_id"]),
      }),
    ),
    add(
      "Expense",
      u
        .from("expenses")
        .select("id, description")
        .eq("org_id", input.orgId)
        .eq("expense_state", "Proposed")
        .is("deleted_at", null)
        .limit(100),
      (r) => ({ id: str(r["id"]), reference: str(r["description"]), projectId: null }),
    ),
    add(
      "Payroll Run",
      u
        .from("payroll_runs")
        .select("id, created_at")
        .eq("org_id", input.orgId)
        .eq("payroll_run_state", "Calculated")
        .is("deleted_at", null)
        .limit(100),
      (r) => ({ id: str(r["id"]), reference: str(r["created_at"]).slice(0, 10), projectId: null }),
    ),
  ]);
  const failed = steps.find((s) => !s.ok);
  if (failed && !failed.ok) return failed;
  return ok(out);
}

// Trash ------------------------------------------------------------------------------------------------

export interface TrashItem {
  readonly urn: string;
  readonly table: string;
  readonly id: string;
  readonly projectId: string | null;
  readonly title: string | null;
  readonly deletedAt: string;
  readonly deletedBy: string | null;
  readonly purgeAfter: string;
}

/** Deleted rows the viewer can read, newest first, optionally of one table or matching a title. */
export async function listTrash(
  db: XosClient,
  input: { readonly orgId: string; readonly table?: string | null; readonly q?: string | null },
): Promise<Result<TrashItem[]>> {
  let query = untyped(db)
    .from("trash_items")
    .select(
      "subject_urn, subject_table, subject_id, project_id, title, deleted_at, deleted_by, purge_after",
    )
    .eq("org_id", input.orgId)
    .order("deleted_at", { ascending: false })
    .limit(200);
  if (input.table) query = query.eq("subject_table", input.table);
  if (input.q) query = query.ilike("title", `%${input.q.replace(/[%_]/g, "")}%`);
  const result = await rows(query);
  if (!result.ok) return result;
  return ok(
    result.data.map((r) => ({
      urn: str(r["subject_urn"]),
      table: str(r["subject_table"]),
      id: str(r["subject_id"]),
      projectId: strOrNull(r["project_id"]),
      title: strOrNull(r["title"]),
      deletedAt: str(r["deleted_at"]),
      deletedBy: strOrNull(r["deleted_by"]),
      purgeAfter: str(r["purge_after"]),
    })),
  );
}

/** Restores a deleted row and the rows deleted with it; returns how many came back. */
export async function restoreTrashItem(
  db: XosClient,
  input: { readonly table: string; readonly id: string },
): Promise<Result<number>> {
  return call(
    db,
    "restore_trash_item",
    { p_subject_table: input.table, p_subject_id: input.id },
    num,
  );
}

// Templates ----------------------------------------------------------------------------------------------

export type TemplateItemKind = "Scope Node" | "Record";

export interface TemplateItem {
  readonly id: string;
  readonly kind: TemplateItemKind;
  readonly order: number;
  readonly name: string;
  readonly scopeKind: string | null;
  readonly scopeCodeSuffix: string | null;
  readonly recordKind: string | null;
  readonly xyz: string | null;
  readonly phaseCode: string | null;
  readonly dueOffsetDays: number | null;
}

export interface TemplateVersion {
  readonly id: string;
  readonly number: number;
  readonly notes: string | null;
  readonly timeZone: string | null;
  readonly currency: string | null;
  readonly durationDays: number | null;
  readonly publishedAt: string | null;
  readonly items: readonly TemplateItem[];
}

export interface Template {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly currentVersionId: string | null;
  readonly updatedAt: string;
  readonly versions: readonly TemplateVersion[];
  readonly applications: number;
}

/** The org's templates with every version and item, and how many projects each created. */
export async function listTemplates(db: XosClient, orgId: string): Promise<Result<Template[]>> {
  const u = untyped(db);
  const [templates, versions, items, applications] = await Promise.all([
    rows(
      u
        .from("templates")
        .select("id, name, description, current_version_id, updated_at")
        .eq("org_id", orgId)
        .is("deleted_at", null)
        .order("name"),
    ),
    rows(
      u
        .from("template_versions")
        .select(
          "id, template_id, version_number, notes, default_time_zone, default_currency_code, duration_days, published_at",
        )
        .eq("org_id", orgId)
        .is("deleted_at", null)
        .order("version_number", { ascending: false }),
    ),
    rows(
      u
        .from("template_items")
        .select(
          "id, template_version_id, item_kind, sort_order, name, scope_kind, scope_code_suffix, record_kind, xyz, phase_code, due_offset_days",
        )
        .eq("org_id", orgId)
        .is("deleted_at", null)
        .order("sort_order"),
    ),
    rows(u.from("template_applications").select("template_id").eq("org_id", orgId)),
  ]);
  if (!templates.ok) return templates;
  if (!versions.ok) return versions;
  if (!items.ok) return items;
  if (!applications.ok) return applications;
  return ok(
    templates.data.map((t) => ({
      id: str(t["id"]),
      name: str(t["name"]),
      description: strOrNull(t["description"]),
      currentVersionId: strOrNull(t["current_version_id"]),
      updatedAt: str(t["updated_at"]),
      applications: applications.data.filter((a) => str(a["template_id"]) === str(t["id"])).length,
      versions: versions.data
        .filter((v) => str(v["template_id"]) === str(t["id"]))
        .map((v) => ({
          id: str(v["id"]),
          number: num(v["version_number"]),
          notes: strOrNull(v["notes"]),
          timeZone: strOrNull(v["default_time_zone"]),
          currency: strOrNull(v["default_currency_code"])?.trim() ?? null,
          durationDays: numOrNull(v["duration_days"]),
          publishedAt: strOrNull(v["published_at"]),
          items: items.data
            .filter((i) => str(i["template_version_id"]) === str(v["id"]))
            .map((i) => ({
              id: str(i["id"]),
              kind: str(i["item_kind"]) as TemplateItemKind,
              order: num(i["sort_order"]),
              name: str(i["name"]),
              scopeKind: strOrNull(i["scope_kind"]),
              scopeCodeSuffix: strOrNull(i["scope_code_suffix"]),
              recordKind: strOrNull(i["record_kind"]),
              xyz: strOrNull(i["xyz"])?.trim() ?? null,
              phaseCode: strOrNull(i["phase_code"]),
              dueOffsetDays: numOrNull(i["due_offset_days"]),
            })),
        })),
    })),
  );
}

/** Creates a template with an empty draft first version; returns the template id. */
export async function createTemplate(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly name: string;
    readonly description: string | null;
    readonly timeZone: string | null;
    readonly currency: string | null;
    readonly durationDays: number | null;
  },
): Promise<Result<string>> {
  const template = await write(
    untyped(db)
      .from("templates")
      .insert({ org_id: input.orgId, name: input.name.trim(), description: input.description })
      .select("id")
      .single(),
  );
  if (!template.ok) return template;
  const version = await write(
    untyped(db)
      .from("template_versions")
      .insert({
        template_id: template.data,
        default_time_zone: input.timeZone,
        default_currency_code: input.currency,
        duration_days: input.durationDays,
      })
      .select("id")
      .single(),
  );
  return version.ok ? ok(template.data) : version;
}

export async function deleteTemplate(db: XosClient, id: string): Promise<Result<string>> {
  return write(
    untyped(db).from("templates").update({ deleted_at: now() }).eq("id", id).select("id"),
  );
}

/** A new draft version that starts as a copy of the latest version's defaults and items. */
export async function createDraftVersion(
  db: XosClient,
  input: { readonly template: Template },
): Promise<Result<string>> {
  const latest = input.template.versions[0];
  const version = await write(
    untyped(db)
      .from("template_versions")
      .insert({
        template_id: input.template.id,
        default_time_zone: latest?.timeZone ?? null,
        default_currency_code: latest?.currency ?? null,
        duration_days: latest?.durationDays ?? null,
      })
      .select("id")
      .single(),
  );
  if (!version.ok || !latest || latest.items.length === 0) return version;
  const { error } = await untyped(db)
    .from("template_items")
    .insert(
      latest.items.map((i) => ({
        template_version_id: version.data,
        item_kind: i.kind,
        sort_order: i.order,
        name: i.name,
        scope_kind: i.scopeKind,
        scope_code_suffix: i.scopeCodeSuffix,
        record_kind: i.recordKind,
        xyz: i.xyz,
        phase_code: i.phaseCode,
        due_offset_days: i.dueOffsetDays,
      })),
    );
  return error ? fail(toDataError(error)) : version;
}

export async function updateTemplateVersion(
  db: XosClient,
  input: {
    readonly id: string;
    readonly notes: string | null;
    readonly timeZone: string | null;
    readonly currency: string | null;
    readonly durationDays: number | null;
  },
): Promise<Result<string>> {
  return write(
    untyped(db)
      .from("template_versions")
      .update({
        notes: input.notes,
        default_time_zone: input.timeZone,
        default_currency_code: input.currency,
        duration_days: input.durationDays,
      })
      .eq("id", input.id)
      .select("id"),
  );
}

export interface TemplateItemInput {
  readonly versionId: string;
  readonly kind: TemplateItemKind;
  readonly name: string;
  readonly scopeKind: "Show" | "Standing Venue" | null;
  readonly scopeCodeSuffix: string | null;
  readonly recordKind: string | null;
  readonly xyz: "X" | "Y" | "Z" | null;
  readonly phaseCode: string | null;
  readonly dueOffsetDays: number | null;
}

export async function addTemplateItem(
  db: XosClient,
  input: TemplateItemInput,
): Promise<Result<string>> {
  const last = await rows(
    untyped(db)
      .from("template_items")
      .select("sort_order")
      .eq("template_version_id", input.versionId)
      .is("deleted_at", null)
      .order("sort_order", { ascending: false })
      .limit(1),
  );
  if (!last.ok) return last;
  const scope = input.kind === "Scope Node";
  return write(
    untyped(db)
      .from("template_items")
      .insert({
        template_version_id: input.versionId,
        item_kind: input.kind,
        sort_order: num(last.data[0]?.["sort_order"]) + 1,
        name: input.name.trim(),
        scope_kind: scope ? input.scopeKind : null,
        scope_code_suffix: scope ? input.scopeCodeSuffix : null,
        record_kind: scope ? null : input.recordKind,
        xyz: scope ? null : input.xyz,
        phase_code: scope ? null : input.phaseCode,
        due_offset_days: scope ? null : input.dueOffsetDays,
      })
      .select("id")
      .single(),
  );
}

export async function removeTemplateItem(db: XosClient, id: string): Promise<Result<string>> {
  return write(
    untyped(db).from("template_items").update({ deleted_at: now() }).eq("id", id).select("id"),
  );
}

export async function publishTemplateVersion(db: XosClient, id: string): Promise<Result<string>> {
  return call(db, "publish_template_version", { p_template_version_id: id }, str);
}

/** Creates a project from a template's current version; returns the new project's key. */
export async function applyTemplate(
  db: XosClient,
  input: {
    readonly templateId: string;
    readonly projectKey: string;
    readonly name: string;
    readonly timeZone: string | null;
    readonly startsOn: string | null;
    readonly venueId: string | null;
  },
): Promise<Result<{ applicationId: string; projectId: string }>> {
  const applied = await call(
    db,
    "apply_template",
    {
      p_template_id: input.templateId,
      p_project_key: input.projectKey,
      p_name: input.name.trim(),
      p_time_zone: input.timeZone,
      p_starts_on: input.startsOn,
      p_venue_id: input.venueId,
    },
    str,
  );
  if (!applied.ok) return applied;
  const row = await rows(
    untyped(db).from("template_applications").select("project_id").eq("id", applied.data).limit(1),
  );
  if (!row.ok) return row;
  return ok({ applicationId: applied.data, projectId: str(row.data[0]?.["project_id"]) });
}

export async function createTemplateFromProject(
  db: XosClient,
  input: { readonly projectId: string; readonly name: string; readonly description: string | null },
): Promise<Result<string>> {
  return call(
    db,
    "create_template_from_project",
    { p_project_id: input.projectId, p_name: input.name.trim(), p_description: input.description },
    str,
  );
}

// Org state labels -----------------------------------------------------------------------------------------

export interface StateLabel {
  readonly state: string;
  readonly ordinal: number;
  readonly label: string;
  readonly relabeled: boolean;
  readonly labelId: string | null;
}

/** The nine record states with the org's display label of each. */
export async function listStateLabels(db: XosClient, orgId: string): Promise<Result<StateLabel[]>> {
  const [display, labels] = await Promise.all([
    rows(
      untyped(db)
        .from("record_state_display")
        .select("record_state, ordinal, label, relabeled")
        .eq("org_id", orgId)
        .order("ordinal"),
    ),
    rows(
      untyped(db)
        .from("org_state_labels")
        .select("id, record_state")
        .eq("org_id", orgId)
        .is("deleted_at", null),
    ),
  ]);
  if (!display.ok) return display;
  if (!labels.ok) return labels;
  return ok(
    display.data.map((d) => ({
      state: str(d["record_state"]),
      ordinal: num(d["ordinal"]),
      label: str(d["label"]),
      relabeled: d["relabeled"] === true,
      labelId: strOrNull(
        labels.data.find((l) => str(l["record_state"]) === str(d["record_state"]))?.["id"],
      ),
    })),
  );
}

/** Sets an org's label for a record state, or clears it back to the canon name when label is null. */
export async function setStateLabel(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly state: string;
    readonly label: string | null;
    readonly labelId: string | null;
  },
): Promise<Result<string | null>> {
  const label = input.label?.trim() ?? "";
  if (input.labelId) {
    if (label === "") {
      return write(
        untyped(db)
          .from("org_state_labels")
          .update({ deleted_at: now() })
          .eq("id", input.labelId)
          .select("id"),
      );
    }
    return write(
      untyped(db).from("org_state_labels").update({ label }).eq("id", input.labelId).select("id"),
    );
  }
  if (label === "") return ok(null);
  return write(
    untyped(db)
      .from("org_state_labels")
      .insert({ org_id: input.orgId, record_state: input.state, label })
      .select("id")
      .single(),
  );
}

// Support screenshots (1034) -------------------------------------------------------------------------------

// Approval rules: passes, deliveries and equipment (P9, migrations 2860 and 2862) ----------------------------

export const APPROVAL_RULE_SUBJECTS = ["Pass", "Delivery", "Equipment"] as const;
export type ApprovalRuleSubject = (typeof APPROVAL_RULE_SUBJECTS)[number];

export interface ApprovalRuleStep {
  readonly id: string;
  readonly order: number;
  readonly name: string;
  readonly roleId: string | null;
  readonly membershipId: string | null;
  readonly engagementId: string | null;
  /** Engagement steps only: the approver decides from the email without signing in, with an emailed code. */
  readonly signedOutLinks: boolean;
}

export interface ApprovalRule {
  readonly id: string;
  readonly projectId: string;
  readonly subject: ApprovalRuleSubject;
  readonly name: string;
  readonly description: string | null;
  /** The one filter of the rule's subject: a credential category, a dock zone or an asset class; null for all. */
  readonly filterId: string | null;
  readonly state: PolicyState;
  readonly steps: readonly ApprovalRuleStep[];
}

/** A project's approval rules with their steps, Active first (app.approval_rules, 2860). */
export async function listApprovalRules(
  db: XosClient,
  projectId: string,
): Promise<Result<ApprovalRule[]>> {
  const rules = await rows(
    untyped(db)
      .from("approval_rules")
      .select(
        "id, project_id, subject, name, description, credential_category_id, zone_id, asset_class_id, rule_state, steps:approval_rule_steps(id, step_order, name, approver_role_id, approver_membership_id, approver_engagement_id, signed_out_links, deleted_at)",
      )
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .order("name"),
  );
  if (!rules.ok) return rules;
  const rank: Record<string, number> = { Active: 0, Draft: 1, Retired: 2 };
  return ok(
    rules.data
      .map((r) => ({
        id: str(r["id"]),
        projectId: str(r["project_id"]),
        subject: str(r["subject"]) as ApprovalRuleSubject,
        name: str(r["name"]),
        description: strOrNull(r["description"]),
        filterId:
          strOrNull(r["credential_category_id"]) ??
          strOrNull(r["zone_id"]) ??
          strOrNull(r["asset_class_id"]),
        state: str(r["rule_state"]) as PolicyState,
        steps: (Array.isArray(r["steps"]) ? (r["steps"] as Raw[]) : [])
          .filter((s) => s["deleted_at"] === null || s["deleted_at"] === undefined)
          .map((s) => ({
            id: str(s["id"]),
            order: num(s["step_order"]),
            name: str(s["name"]),
            roleId: strOrNull(s["approver_role_id"]),
            membershipId: strOrNull(s["approver_membership_id"]),
            engagementId: strOrNull(s["approver_engagement_id"]),
            signedOutLinks: s["signed_out_links"] === true,
          }))
          .sort((a, b) => a.order - b.order),
      }))
      .sort((a, b) => (rank[a.state] ?? 3) - (rank[b.state] ?? 3) || a.name.localeCompare(b.name)),
  );
}

export interface ApprovalRuleInput {
  readonly id?: string;
  readonly projectId: string;
  readonly subject: ApprovalRuleSubject;
  readonly name: string;
  readonly description: string | null;
  readonly filterId: string | null;
}

const RULE_FILTER_COLUMN: Record<ApprovalRuleSubject, string> = {
  Pass: "credential_category_id",
  Delivery: "zone_id",
  Equipment: "asset_class_id",
};

/** Creates a Draft rule, or edits one; an Active or Retired rule keeps its subject and filter. */
export async function saveApprovalRule(
  db: XosClient,
  input: ApprovalRuleInput,
): Promise<Result<string>> {
  const values: Raw = {
    name: input.name.trim(),
    description: input.description?.trim() || null,
    subject: input.subject,
    credential_category_id: null,
    zone_id: null,
    asset_class_id: null,
    [RULE_FILTER_COLUMN[input.subject]]: input.filterId,
  };
  if (input.id)
    return write(
      untyped(db).from("approval_rules").update(values).eq("id", input.id).select("id"),
    );
  return write(
    untyped(db)
      .from("approval_rules")
      .insert({ ...values, project_id: input.projectId })
      .select("id")
      .single(),
  );
}

export async function deleteApprovalRule(db: XosClient, id: string): Promise<Result<string>> {
  return write(
    untyped(db).from("approval_rules").update({ deleted_at: now() }).eq("id", id).select("id"),
  );
}

export type ApprovalRuleApprover =
  | { readonly kind: "role"; readonly id: string }
  | { readonly kind: "member"; readonly id: string }
  | { readonly kind: "engagement"; readonly id: string; readonly signedOutLinks: boolean };

/** Adds a step after the rule's last one: a role, a member, or an engagement of the project. */
export async function saveApprovalRuleStep(
  db: XosClient,
  input: { readonly ruleId: string; readonly name: string; readonly approver: ApprovalRuleApprover },
): Promise<Result<string>> {
  const last = await rows(
    untyped(db)
      .from("approval_rule_steps")
      .select("step_order")
      .eq("approval_rule_id", input.ruleId)
      .is("deleted_at", null)
      .order("step_order", { ascending: false })
      .limit(1),
  );
  if (!last.ok) return last;
  const a = input.approver;
  return write(
    untyped(db)
      .from("approval_rule_steps")
      .insert({
        approval_rule_id: input.ruleId,
        step_order: num(last.data[0]?.["step_order"]) + 1,
        name: input.name.trim(),
        approver_role_id: a.kind === "role" ? a.id : null,
        approver_membership_id: a.kind === "member" ? a.id : null,
        approver_engagement_id: a.kind === "engagement" ? a.id : null,
        signed_out_links: a.kind === "engagement" && a.signedOutLinks,
      })
      .select("id")
      .single(),
  );
}

export async function removeApprovalRuleStep(db: XosClient, id: string): Promise<Result<string>> {
  return write(
    untyped(db).from("approval_rule_steps").update({ deleted_at: now() }).eq("id", id).select("id"),
  );
}

/** Activates or retires a rule; activating refuses a rule without steps or with an unreachable outside approver. */
export async function transitionApprovalRule(
  db: XosClient,
  input: {
    readonly id: string;
    readonly from: PolicyState;
    readonly to: PolicyState;
    readonly reason: string;
  },
): Promise<Result<string>> {
  return call(
    db,
    "transition_approval_rule",
    {
      p_approval_rule_id: input.id,
      p_expected: input.from,
      p_next: input.to,
      p_reason: input.reason,
    },
    str,
  );
}

/** A pass, dock booking or equipment approval with its computed state (app.subject_approval_status, ADR 0103). */
export interface SubjectApproval {
  readonly id: string;
  readonly projectId: string;
  readonly ruleId: string;
  readonly ruleName: string;
  readonly subject: ApprovalRuleSubject;
  readonly credentialId: string | null;
  readonly dockSlotId: string | null;
  readonly requestedBy: string | null;
  readonly createdAt: string;
  readonly state: ApprovalState;
  readonly currentStep: number | null;
  readonly currentStepName: string | null;
  /** False while In Review when no one may decide the current step: Approvals says so, and rule writers cancel it. */
  readonly currentStepHasApprover: boolean;
  readonly stepCount: number;
  readonly waitingSince: string;
  readonly viewerMayDecide: boolean;
  readonly approverNames: readonly string[];
  readonly cancelReason: string | null;
}

const SUBJECT_APPROVAL_COLUMNS =
  "id, project_id, approval_rule_id, rule_name, subject, credential_id, dock_slot_id, requested_by, created_at, approval_state, current_step, current_step_name, current_step_has_approver, step_count, waiting_since, cancel_reason, viewer_may_decide, current_step_approver_names";

export function toSubjectApproval(r: Raw): SubjectApproval {
  return {
    id: str(r["id"]),
    projectId: str(r["project_id"]),
    ruleId: str(r["approval_rule_id"]),
    ruleName: str(r["rule_name"]),
    subject: str(r["subject"]) as ApprovalRuleSubject,
    credentialId: strOrNull(r["credential_id"]),
    dockSlotId: strOrNull(r["dock_slot_id"]),
    requestedBy: strOrNull(r["requested_by"]),
    createdAt: str(r["created_at"]),
    state: str(r["approval_state"]) as ApprovalState,
    currentStep: numOrNull(r["current_step"]),
    currentStepName: strOrNull(r["current_step_name"]),
    currentStepHasApprover: r["current_step_has_approver"] !== false,
    stepCount: num(r["step_count"]),
    waitingSince: str(r["waiting_since"]),
    viewerMayDecide: r["viewer_may_decide"] === true,
    approverNames: Array.isArray(r["current_step_approver_names"])
      ? (r["current_step_approver_names"] as unknown[]).map(str)
      : [],
    cancelReason: strOrNull(r["cancel_reason"]),
  };
}

/**
 * Subject approvals the viewer may read, newest first: the org's, or only those of the given passes or dock slots
 * (the credentials pages and the dock schedule show their state as a chip).
 */
export async function listSubjectApprovals(
  db: XosClient,
  filter: {
    readonly orgId?: string;
    readonly credentialIds?: readonly string[];
    readonly dockSlotIds?: readonly string[];
  },
): Promise<Result<SubjectApproval[]>> {
  if (filter.credentialIds?.length === 0 || filter.dockSlotIds?.length === 0) return ok([]);
  let query = untyped(db).from("subject_approval_status").select(SUBJECT_APPROVAL_COLUMNS);
  if (filter.orgId) query = query.eq("org_id", filter.orgId);
  if (filter.credentialIds) query = query.in("credential_id", [...filter.credentialIds]);
  if (filter.dockSlotIds) query = query.in("dock_slot_id", [...filter.dockSlotIds]);
  const result = await rows(
    query.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(200),
  );
  if (!result.ok) return result;
  return ok(result.data.map(toSubjectApproval));
}

/** The latest approval of each pass or dock slot, keyed by its id; a canceled one counts only when nothing newer is. */
export function approvalBySubject(
  approvals: readonly SubjectApproval[],
): ReadonlyMap<string, SubjectApproval> {
  const out = new Map<string, SubjectApproval>();
  for (const a of approvals) {
    const key = a.credentialId ?? a.dockSlotId;
    if (!key) continue;
    const held = out.get(key);
    if (!held || (held.state === "Canceled" && a.state !== "Canceled")) out.set(key, a);
  }
  return out;
}

export async function decideSubjectApproval(
  db: XosClient,
  input: { readonly id: string; readonly approved: boolean; readonly comment: string | null },
): Promise<Result<string>> {
  return call(
    db,
    "decide_subject_approval",
    { p_subject_approval_id: input.id, p_approved: input.approved, p_comment: input.comment },
    str,
  );
}

export async function cancelSubjectApproval(
  db: XosClient,
  input: { readonly id: string; readonly reason: string },
): Promise<Result<string>> {
  return call(
    db,
    "cancel_subject_approval",
    { p_subject_approval_id: input.id, p_reason: input.reason },
    str,
  );
}

export type ReminderSubjectTable = "approval_instances" | "timesheets" | "subject_approvals";

/** When a pending approval's approvers were last told, and when they may be told again (app.approval_reminder_status). */
export interface ReminderStatus {
  readonly subjectTable: ReminderSubjectTable;
  readonly subjectId: string;
  readonly step: number | null;
  readonly waitingSince: string;
  readonly lastNotifiedAt: string;
  readonly remindersSent: number;
  readonly reminderLimit: number;
  readonly remindersEnabled: boolean;
  /** Null when automatic reminders are off or the limit is reached. */
  readonly nextReminderAt: string | null;
  /** When Remind approvers may next be pressed; null once the limit is reached. */
  readonly nextManualAt: string | null;
}

export function toReminderStatus(r: Raw): ReminderStatus {
  return {
    subjectTable: str(r["subject_table"]) as ReminderSubjectTable,
    subjectId: str(r["subject_id"]),
    step: numOrNull(r["step_order"]),
    waitingSince: str(r["waiting_since"]),
    lastNotifiedAt: str(r["last_notified_at"]),
    remindersSent: num(r["reminders_sent"]),
    reminderLimit: num(r["reminder_limit"]),
    remindersEnabled: r["reminders_enabled"] !== false,
    nextReminderAt: strOrNull(r["next_reminder_at"]),
    nextManualAt: strOrNull(r["next_manual_at"]),
  };
}

/** Reminder status of every pending approval of the org the viewer may read, keyed by subject id. */
export async function listReminderStatus(
  db: XosClient,
  orgId: string,
): Promise<Result<ReadonlyMap<string, ReminderStatus>>> {
  const result = await rows(
    untyped(db)
      .from("approval_reminder_status")
      .select(
        "subject_table, subject_id, step_order, waiting_since, last_notified_at, reminders_sent, reminder_limit, reminders_enabled, next_reminder_at, next_manual_at",
      )
      .eq("org_id", orgId)
      .limit(500),
  );
  if (!result.ok) return result;
  return ok(new Map(result.data.map((r) => [str(r["subject_id"]), toReminderStatus(r)])));
}

/** Remind approvers: a manual reminder to the step's approvers, at most every 4 hours. Returns the reminder number. */
export async function remindApprovers(
  db: XosClient,
  input: { readonly subjectTable: ReminderSubjectTable; readonly subjectId: string },
): Promise<Result<number>> {
  return call(
    db,
    "remind_approvers",
    { p_subject_table: input.subjectTable, p_subject_id: input.subjectId },
    num,
  );
}

export const SCREENSHOT_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
} as const;
export const SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Uploads a screenshot for a support request to the private support-screenshots bucket, under the
 * uploader's own folder (<person_id>/<random name>), so only they and the platform's support staff
 * read it. Returns the object path to send with the request's diagnostics.
 */
export async function uploadSupportScreenshot(
  db: XosClient,
  input: { readonly personId: string; readonly file: Blob },
): Promise<Result<string>> {
  const type = input.file.type as keyof typeof SCREENSHOT_TYPES;
  const extension = SCREENSHOT_TYPES[type];
  if (!extension)
    return fail({ kind: "invalid", message: "A screenshot is a PNG, JPEG or WebP image." });
  if (input.file.size > SCREENSHOT_MAX_BYTES) {
    return fail({ kind: "invalid", message: "A screenshot is at most 5 MB." });
  }
  const path = `${input.personId}/${crypto.randomUUID()}.${extension}`;
  const { error } = await untyped(db)
    .storage.from("support-screenshots")
    .upload(path, input.file, { contentType: type, upsert: false });
  if (error) return fail({ kind: "unexpected", message: error.message });
  return ok(path);
}
