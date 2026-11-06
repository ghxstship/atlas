import type { XosClient } from "./client.ts";
import type { Database } from "./database.types.ts";
import type { DatabaseErrorLike } from "./result.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Reusable vendor intake links (B2, ADR 0141; migrations 2914 and 2915): one link and access code a
 * project gives to many vendors or contractors. The no-account part ends at reading the intake:
 * everything collected after that uses the person's session and the existing secure paths, so a token
 * surface never carries Restricted data. A request carries references only.
 */

export const INTAKE_TOKEN = /^xvin_[0-9a-f]{64}$/;
export const INTAKE_GRANT = /^xvig_[0-9a-f]{64}$/;
export const MAX_INTAKE_DAYS = 90;

export function intakePath(token: string): string {
  return `/onboard/${token}`;
}

export const INTAKE_REFUSALS = [
  "intake_link_invalid",
  "intake_link_rate_limited",
  "intake_link_expired",
  "intake_link_full",
  "intake_link_locked",
  "intake_access_code_required",
  "intake_access_code",
  "intake_grant",
  "intake_agreement_unavailable",
  "org_read_only",
] as const;

export type IntakeRefusal = (typeof INTAKE_REFUSALS)[number];

export function parseIntakeRefusal(reason: unknown): IntakeRefusal {
  return (INTAKE_REFUSALS as readonly unknown[]).includes(reason)
    ? (reason as IntakeRefusal)
    : "intake_link_invalid";
}

/** True for a refusal the access code form answers. */
export function intakeAsksForCode(reason: IntakeRefusal): boolean {
  return (
    reason === "intake_grant" ||
    reason === "intake_access_code_required" ||
    reason === "intake_access_code"
  );
}

export type IntakeRefused = { readonly refused: true; readonly reason: IntakeRefusal };

// Managing links (signed in) -----------------------------------------------------------------------

export interface CreatedIntakeLink {
  readonly id: string;
  /** Shown once; only its hash is stored. */
  readonly token: string;
  /** Shown once; send it apart from the link. */
  readonly accessCode: string;
  readonly expiresAt: string;
}

export interface NewIntakeLink {
  readonly projectId: string;
  readonly title: string;
  readonly roleType: "Vendor" | "Contractor";
  readonly roleCode: string;
  readonly workerClassification: string;
  readonly payBasis: string | null;
  readonly arrangement: string | null;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly expiresAt: string;
  readonly counterpartyType: string | null;
  readonly agreementDocumentId: string | null;
  readonly instructions: string | null;
  readonly note: string | null;
  readonly collectTaxForm: boolean;
  readonly collectPayout: boolean;
  readonly collectInvoice: boolean;
  readonly maxRequests: number;
}

export async function createIntakeLink(
  db: XosClient,
  input: NewIntakeLink,
): Promise<Result<CreatedIntakeLink>> {
  const { data, error } = await db.rpc("create_vendor_intake_link", {
    p_project_id: input.projectId,
    p_title: input.title,
    p_role_type: input.roleType,
    p_role_code: input.roleCode,
    p_worker_classification: input.workerClassification,
    p_pay_basis: input.payBasis as string,
    p_arrangement: input.arrangement as string,
    p_start_date: input.startDate,
    p_expires_at: input.expiresAt,
    ...(input.endDate === null ? {} : { p_end_date: input.endDate }),
    ...(input.counterpartyType === null ? {} : { p_counterparty_type: input.counterpartyType }),
    ...(input.agreementDocumentId === null
      ? {}
      : { p_agreement_document_id: input.agreementDocumentId }),
    ...(input.instructions === null ? {} : { p_instructions: input.instructions }),
    ...(input.note === null ? {} : { p_note: input.note }),
    p_collect_tax_form: input.collectTaxForm,
    p_collect_payout: input.collectPayout,
    p_collect_invoice: input.collectInvoice,
    p_max_requests: input.maxRequests,
  });
  if (error) return fail(toDataError(error));
  const row = (Array.isArray(data) ? data[0] : null) as {
    vendor_intake_link_id: string;
    token: string | null;
    access_code: string | null;
    expires_at: string;
  } | null;
  if (!row?.token || !row.access_code) {
    return fail({ kind: "unexpected", message: "create_vendor_intake_link returned no token" });
  }
  return ok({
    id: row.vendor_intake_link_id,
    token: row.token,
    accessCode: row.access_code,
    expiresAt: row.expires_at,
  });
}

export async function regenerateIntakeLink(
  db: XosClient,
  id: string,
): Promise<Result<Omit<CreatedIntakeLink, "id">>> {
  const { data, error } = await db.rpc("regenerate_vendor_intake_link", { p_id: id });
  if (error) return fail(toDataError(error));
  const row = (Array.isArray(data) ? data[0] : null) as {
    token: string | null;
    access_code: string | null;
    expires_at: string;
  } | null;
  if (!row?.token || !row.access_code) {
    return fail({ kind: "unexpected", message: "regenerate_vendor_intake_link returned no token" });
  }
  return ok({ token: row.token, accessCode: row.access_code, expiresAt: row.expires_at });
}

export async function revokeIntakeLink(db: XosClient, id: string): Promise<Result<string>> {
  const { data, error } = await db.rpc("revoke_vendor_intake_link", { p_id: id });
  if (error) return fail(toDataError(error));
  return ok(String(data));
}

// The team's view of requests ------------------------------------------------------------------------

export type IntakeRequestState = Database["app"]["Enums"]["join_request_state"];

export interface IntakeRequest {
  readonly id: string;
  readonly linkId: string;
  readonly projectId: string;
  readonly requestedBy: string;
  readonly accountId: string | null;
  readonly taxFormId: string | null;
  readonly payoutAccountId: string | null;
  readonly signerName: string | null;
  readonly signedAt: string | null;
  readonly hasInvoiceDraft: boolean;
  readonly state: IntakeRequestState;
  readonly decisionReason: string | null;
  readonly engagementId: string | null;
  readonly createdAt: string;
}

const REQUEST_COLUMNS =
  "id, vendor_intake_link_id, project_id, requested_by, account_id, tax_form_id, payout_account_id, signer_name, signed_at, invoice_draft, request_state, decision_reason, engagement_id, created_at";

interface RequestRow {
  id: string;
  vendor_intake_link_id: string;
  project_id: string;
  requested_by: string;
  account_id: string | null;
  tax_form_id: string | null;
  payout_account_id: string | null;
  signer_name: string | null;
  signed_at: string | null;
  invoice_draft: unknown;
  request_state: IntakeRequestState;
  decision_reason: string | null;
  engagement_id: string | null;
  created_at: string;
}

export async function listIntakeRequests(
  db: XosClient,
  projectId: string,
): Promise<Result<IntakeRequest[]>> {
  const { data, error } = await db
    .from("vendor_intake_requests")
    .select(REQUEST_COLUMNS)
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(
    ((data ?? []) as unknown as RequestRow[]).map((r) => ({
      id: r.id,
      linkId: r.vendor_intake_link_id,
      projectId: r.project_id,
      requestedBy: r.requested_by,
      accountId: r.account_id,
      taxFormId: r.tax_form_id,
      payoutAccountId: r.payout_account_id,
      signerName: r.signer_name,
      signedAt: r.signed_at,
      hasInvoiceDraft: r.invoice_draft !== null,
      state: r.request_state,
      decisionReason: r.decision_reason,
      engagementId: r.engagement_id,
      createdAt: r.created_at,
    })),
  );
}

export interface IntakeRequestParty {
  readonly requesterName: string;
  readonly accountName: string | null;
}

/** The party's names through app.vendor_intake_request_party; a member cannot read them directly. */
export async function intakeRequestParty(
  db: XosClient,
  requestId: string,
): Promise<Result<IntakeRequestParty | null>> {
  const { data, error } = await db.rpc("vendor_intake_request_party", {
    p_request_id: requestId,
  });
  if (error) return fail(toDataError(error));
  const row = (Array.isArray(data) ? data[0] : null) as {
    requester_name: string;
    account_name: string | null;
  } | null;
  return ok(row ? { requesterName: row.requester_name, accountName: row.account_name } : null);
}

/** Approves into an Onboarding engagement or declines. Answers the engagement id or the request id. */
export async function decideIntakeRequest(
  db: XosClient,
  input: { readonly id: string; readonly approve: boolean; readonly reason: string | null },
): Promise<Result<string>> {
  const { data, error } = await db.rpc("decide_vendor_intake", {
    p_request_id: input.id,
    p_approve: input.approve,
    ...(input.reason === null ? {} : { p_reason: input.reason }),
  });
  if (error) return fail(toDataError(error));
  return ok(String(data));
}

/** What the panel may say about the party's tax form and payout, by the viewer's own RLS. */
export interface IntakeOnFile {
  readonly taxFormKind: string | null;
  readonly tinLast4: string | null;
  readonly payoutProvider: string | null;
  readonly payoutLast4: string | null;
}

/**
 * Reads a request's tax form and payout rows under the viewer's own row level security
 * (data.restricted.read.tax, data.restricted.read.banking). A viewer without them gets nulls and the
 * panel says only that the form or reference is on file.
 */
export async function intakeOnFile(
  db: XosClient,
  request: { readonly taxFormId: string | null; readonly payoutAccountId: string | null },
): Promise<Result<IntakeOnFile>> {
  const formRead = request.taxFormId
    ? await db
        .from("tax_forms")
        .select("form_kind, tin_last4")
        .eq("id", request.taxFormId)
        .maybeSingle()
    : null;
  if (formRead?.error) return fail(toDataError(formRead.error));
  const payoutRead = request.payoutAccountId
    ? await db
        .from("payout_accounts")
        .select("provider, account_last4")
        .eq("id", request.payoutAccountId)
        .maybeSingle()
    : null;
  if (payoutRead?.error) return fail(toDataError(payoutRead.error));
  const form = (formRead?.data ?? null) as unknown as {
    form_kind: string;
    tin_last4: string | null;
  } | null;
  const payout = (payoutRead?.data ?? null) as unknown as {
    provider: string;
    account_last4: string | null;
  } | null;
  return ok({
    taxFormKind: form?.form_kind ?? null,
    tinLast4: form?.tin_last4 ?? null,
    payoutProvider: payout?.provider ?? null,
    payoutLast4: payout?.account_last4 ?? null,
  });
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

export async function openIntake(
  db: XosClient,
  input: {
    readonly token: string;
    readonly accessCode: string | null;
    readonly clientAddress: string | null;
  },
): Promise<
  Result<
    | { readonly refused: false; readonly grant: string; readonly grantExpiresAt: string }
    | IntakeRefused
  >
> {
  if (!INTAKE_TOKEN.test(input.token)) return ok({ refused: true, reason: "intake_link_invalid" });
  const { data, error } = await publicRpc(db).rpc("open_vendor_intake", {
    p_token: input.token,
    p_access_code: input.accessCode,
    p_client_address: input.clientAddress,
  });
  if (error) return fail(toDataError(error));
  const body = (data ?? {}) as Record<string, unknown>;
  if (body["status"] !== "ok" || typeof body["grant"] !== "string") {
    return ok({ refused: true, reason: parseIntakeRefusal(body["reason"]) });
  }
  return ok({
    refused: false,
    grant: body["grant"],
    grantExpiresAt: str(body["grant_expires_at"]),
  });
}

export interface PublicIntake {
  readonly refused: false;
  readonly projectName: string;
  /** The project's zone: dates default and show in it. */
  readonly timeZone: string;
  readonly orgName: string;
  readonly brandName: string;
  readonly brandAccentHex: string | null;
  readonly suppressPoweredBy: boolean;
  readonly expiresAt: string;
  readonly title: string;
  readonly instructions: string | null;
  readonly roleType: "Vendor" | "Contractor";
  readonly roleTitle: string | null;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly collectTaxForm: boolean;
  readonly collectPayout: boolean;
  readonly collectInvoice: boolean;
  /** The org's base currency: where a first invoice starts. */
  readonly currencyCode: string;
  readonly full: boolean;
  readonly agreement: { readonly title: string; readonly version: number } | null;
}

export async function readIntake(
  db: XosClient,
  input: {
    readonly token: string;
    readonly grant: string;
    readonly clientAddress: string | null;
  },
): Promise<Result<PublicIntake | IntakeRefused>> {
  if (!INTAKE_TOKEN.test(input.token)) return ok({ refused: true, reason: "intake_link_invalid" });
  const { data, error } = await publicRpc(db).rpc("vendor_intake", {
    p_token: input.token,
    p_grant: input.grant,
    p_client_address: input.clientAddress,
  });
  if (error) return fail(toDataError(error));
  const b = (data ?? {}) as Record<string, unknown>;
  if (b["status"] !== "ok") return ok({ refused: true, reason: parseIntakeRefusal(b["reason"]) });
  const m = (b["meta"] ?? {}) as Record<string, unknown>;
  const a = b["agreement"] as { title?: unknown; version?: unknown } | null;
  return ok({
    refused: false,
    projectName: str(m["project_name"]),
    timeZone: str(m["time_zone"]) || "UTC",
    orgName: str(m["org_name"]),
    brandName: str(m["brand_name"]),
    brandAccentHex: strOrNull(m["brand_accent_hex"]),
    suppressPoweredBy: m["brand_suppress_powered_by"] === true,
    expiresAt: str(m["expires_at"]),
    title: str(b["title"]),
    instructions: strOrNull(b["instructions"]),
    roleType: b["role_type"] === "Vendor" ? "Vendor" : "Contractor",
    roleTitle: strOrNull(b["role_title"]),
    startDate: str(b["start_date"]),
    endDate: strOrNull(b["end_date"]),
    collectTaxForm: b["collect_tax_form"] === true,
    collectPayout: b["collect_payout"] === true,
    collectInvoice: b["collect_invoice"] === true,
    currencyCode: str(b["currency_code"]),
    full: b["full"] === true,
    agreement: a ? { title: str(a.title), version: Number(a.version) } : null,
  });
}

export async function intakeAgreementTicket(
  db: XosClient,
  input: {
    readonly token: string;
    readonly grant: string;
    readonly clientAddress: string | null;
  },
): Promise<
  Result<
    | {
        readonly refused: false;
        readonly ticket: string;
        readonly filename: string;
        readonly contentType: string;
      }
    | IntakeRefused
  >
> {
  if (!INTAKE_TOKEN.test(input.token)) return ok({ refused: true, reason: "intake_link_invalid" });
  const { data, error } = await publicRpc(db).rpc("vendor_intake_agreement", {
    p_token: input.token,
    p_grant: input.grant,
    p_client_address: input.clientAddress,
  });
  if (error) return fail(toDataError(error));
  const row = (Array.isArray(data) ? data[0] : null) as {
    refusal: string | null;
    ticket: string | null;
    filename: string | null;
    content_type: string | null;
  } | null;
  if (!row || row.refusal || !row.ticket) {
    return ok({ refused: true, reason: parseIntakeRefusal(row?.refusal) });
  }
  return ok({
    refused: false,
    ticket: row.ticket,
    filename: row.filename ?? "",
    contentType: row.content_type ?? "",
  });
}

// The signed-in requester ----------------------------------------------------------------------------

/** The org of a link, for a signed-in caller with its token and grant (app.vendor_intake_org). */
export async function intakeOrgId(
  db: XosClient,
  input: {
    readonly token: string;
    readonly grant: string;
    readonly clientAddress: string | null;
  },
): Promise<Result<string>> {
  const { data, error } = await db.rpc("vendor_intake_org", {
    p_token: input.token,
    p_grant: input.grant,
    ...(input.clientAddress === null ? {} : { p_client_address: input.clientAddress }),
  });
  if (error) return fail(toDataError(error));
  return ok(String(data));
}

export async function addIntakePayoutReference(
  db: XosClient,
  input: {
    readonly token: string;
    readonly grant: string;
    readonly reference: string;
    readonly accountId: string | null;
    readonly clientAddress: string | null;
  },
): Promise<Result<string>> {
  const { data, error } = await db.rpc("add_intake_payout_reference", {
    p_token: input.token,
    p_grant: input.grant,
    p_reference: input.reference,
    ...(input.accountId === null ? {} : { p_account_id: input.accountId }),
    ...(input.clientAddress === null ? {} : { p_client_address: input.clientAddress }),
  });
  if (error) return fail(toDataError(error));
  return ok(String(data));
}

export interface IntakeInvoiceDraft {
  readonly invoice_number: string;
  readonly issue_date: string;
  readonly due_date: string;
  readonly currency_code: string;
  readonly lines: readonly {
    readonly description: string;
    readonly quantity: number;
    readonly unit_price_minor: number | null;
  }[];
}

export async function submitVendorIntake(
  db: XosClient,
  input: {
    readonly token: string;
    readonly grant: string;
    readonly accountId: string | null;
    readonly taxFormId: string | null;
    readonly payoutAccountId: string | null;
    readonly signerName: string | null;
    readonly invoiceDraft: IntakeInvoiceDraft | null;
    readonly clientAddress: string | null;
  },
): Promise<Result<string>> {
  const { data, error } = await db.rpc("submit_vendor_intake", {
    p_token: input.token,
    p_grant: input.grant,
    ...(input.accountId === null ? {} : { p_account_id: input.accountId }),
    ...(input.taxFormId === null ? {} : { p_tax_form_id: input.taxFormId }),
    ...(input.payoutAccountId === null ? {} : { p_payout_account_id: input.payoutAccountId }),
    ...(input.signerName === null ? {} : { p_signer_name: input.signerName }),
    ...(input.invoiceDraft === null ? {} : { p_invoice_draft: input.invoiceDraft as never }),
    ...(input.clientAddress === null ? {} : { p_client_address: input.clientAddress }),
  });
  if (error) return fail(toDataError(error));
  return ok(String(data));
}

export async function withdrawIntakeRequest(db: XosClient, id: string): Promise<Result<void>> {
  const { error } = await db.rpc("withdraw_vendor_intake", { p_request_id: id });
  if (error) return fail(toDataError(error));
  return ok(undefined);
}

export async function submitIntakeInvoice(db: XosClient, id: string): Promise<Result<string>> {
  const { data, error } = await db.rpc("submit_intake_invoice", { p_request_id: id });
  if (error) return fail(toDataError(error));
  return ok(String(data));
}

export interface MyIntakeRequest {
  readonly id: string;
  readonly orgName: string;
  readonly projectName: string;
  readonly title: string;
  readonly state: IntakeRequestState;
  readonly decisionReason: string | null;
  readonly engagementId: string | null;
  readonly invoiceReady: boolean;
  readonly invoiceUsed: boolean;
  readonly createdAt: string;
  /** The reader sent this request and it still waits: who app.withdraw_vendor_intake accepts. */
  readonly viewerCanWithdraw: boolean;
  /** The draft is ready and the money area is open to the reader: what app.submit_engagement_invoice checks. */
  readonly viewerCanSubmitInvoice: boolean;
}

type ExternalFrom = {
  from(view: string): {
    select(columns: string): {
      order(
        column: string,
        options: { ascending: boolean },
      ): PromiseLike<{ data: unknown; error: DatabaseErrorLike | null }>;
    };
  };
};

/** The requests the signed-in person sent or their account holds (api_external, Section 8.7). */
export async function listMyIntakeRequests(db: XosClient): Promise<Result<MyIntakeRequest[]>> {
  const { data, error } = await (db as unknown as { schema(name: string): ExternalFrom })
    .schema("api_external")
    .from("my_vendor_intake_requests")
    .select(
      "id, org_name, project_name, title, request_state, decision_reason, engagement_id, invoice_ready, invoice_used, created_at, viewer_can_withdraw, viewer_can_submit_invoice",
    )
    .order("created_at", { ascending: false });
  if (error) return fail(toDataError(error));
  const rows = (data ?? []) as {
    id: string;
    org_name: string;
    project_name: string;
    title: string;
    request_state: IntakeRequestState;
    decision_reason: string | null;
    engagement_id: string | null;
    invoice_ready: boolean;
    invoice_used: boolean;
    created_at: string;
    viewer_can_withdraw: boolean | null;
    viewer_can_submit_invoice: boolean | null;
  }[];
  return ok(
    rows.map((r) => ({
      id: r.id,
      orgName: r.org_name,
      projectName: r.project_name,
      title: r.title,
      state: r.request_state,
      decisionReason: r.decision_reason,
      engagementId: r.engagement_id,
      invoiceReady: r.invoice_ready,
      invoiceUsed: r.invoice_used,
      createdAt: r.created_at,
      viewerCanWithdraw: r.viewer_can_withdraw === true,
      viewerCanSubmitInvoice: r.viewer_can_submit_invoice === true,
    })),
  );
}

/** The caller's own live tax form for an org, offered instead of asking again (S4.4-37). */
export async function myIntakeTaxForm(
  db: XosClient,
  input: { readonly orgId: string; readonly accountId: string | null; readonly personId: string },
): Promise<Result<{ readonly id: string; readonly kind: string; readonly last4: string } | null>> {
  const base = db
    .from("tax_forms")
    .select("id, form_kind, tin_last4")
    .eq("org_id", input.orgId)
    .is("deleted_at", null);
  const { data, error } = await (
    input.accountId === null
      ? base.eq("person_id", input.personId)
      : base.eq("organization_id", input.accountId)
  )
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) return fail(toDataError(error));
  const row = (
    (data ?? []) as unknown as { id: string; form_kind: string; tin_last4: string }[]
  )[0];
  return ok(row ? { id: row.id, kind: row.form_kind, last4: row.tin_last4 } : null);
}

/** The caller's own live Accounting System reference for an org, offered instead of asking again. */
export async function myIntakePayout(
  db: XosClient,
  input: { readonly orgId: string; readonly accountId: string | null; readonly personId: string },
): Promise<Result<{ readonly id: string; readonly reference: string } | null>> {
  const base = db
    .from("payout_accounts")
    .select("id, provider_account_reference")
    .eq("org_id", input.orgId)
    .eq("provider", "Accounting System")
    .is("deleted_at", null);
  const { data, error } = await (
    input.accountId === null
      ? base.eq("person_id", input.personId)
      : base.eq("organization_id", input.accountId)
  )
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) return fail(toDataError(error));
  const row = ((data ?? []) as unknown as { id: string; provider_account_reference: string }[])[0];
  return ok(row ? { id: row.id, reference: row.provider_account_reference } : null);
}
