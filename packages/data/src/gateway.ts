import type { XosClient } from "./client.ts";
import {
  derivedRow,
  external,
  req,
  type AccountRole,
  type AvailabilityKind,
  type AvailabilityVisibility,
  type EngagementArea,
  type EngagementDocumentKind,
  type EngagementDocumentState,
  type EngagementState,
  type ExternalRoleType,
  type ExternalRow,
  type OnboardingItemKind,
  type PaymentState,
  type PayoutProvider,
  type RecordKind,
  type RecordState,
  type RepresentationScope,
  type TaxFormKind,
  type VerificationMethod,
  type VerificationOutcome,
} from "./gateway-external.ts";
import { toDisplayKey } from "./gateway-keys.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

export type { Database, XosClient } from "./client.ts";
export { getCurrentPerson } from "./identity.ts";
export type { DataError, Result } from "./result.ts";
export * from "./gateway-external.ts";
export * from "./gateway-keys.ts";
export * from "./gateway-marketplace.ts";
export * from "./gateway-operations.ts";
export * from "./gateway-conversations.ts";
export * from "./gateway-public.ts";

/**
 * Gateway repository (Section 4.4, Section 4.5.8): the external party's engagements, documents,
 * onboarding, threads, shared records, money, accounts, representation, availability and ratings.
 * Every read goes through `api_external` (Section 8.7); every write goes through an A28 RPC or a
 * column grant of 0700 to 0750, so the database decides every refusal and the UI explains it.
 */

// Engagements ------------------------------------------------------------------------------------

export interface Engagement {
  readonly id: string;
  readonly key: string;
  readonly orgId: string;
  readonly orgName: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly roleType: ExternalRoleType;
  /** The canon role and its job title; null for Client and Sponsor engagements, which carry no work terms (1624). */
  readonly roleCode: string | null;
  readonly jobTitle: string | null;
  readonly personId: string | null;
  readonly accountId: string | null;
  /** Null for an unpaid engagement and for Client and Sponsor engagements. */
  readonly payBasis: string | null;
  readonly arrangement: string | null;
  /** The party's own rate in minor units while the money area is open; null when unpriced or closed. */
  readonly rateMinor: number | null;
  readonly rateCurrency: string | null;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly state: EngagementState;
  readonly areas: readonly EngagementArea[];
  /** IANA time zone of the project: the calendar the engagement's dates follow (1390). */
  readonly projectTimeZone: string;
  /** Names lock (R5, 2656): after this instant the company side names no new crew; null means no lock. */
  readonly rosterLocksAt: string | null;
}

const ENGAGEMENT_COLUMNS =
  "id, org_id, org_name, project_id, project_name, role_type, role_code, job_title, person_id, account_id, pay_basis, arrangement, rate_minor, rate_currency_code, start_date, end_date, engagement_state, areas, project_time_zone, roster_locks_at";

function toEngagement(row: ExternalRow<"engagements">): Engagement {
  const id = req(row.id, "engagements.id");
  return {
    id,
    key: toDisplayKey("engagement", id),
    orgId: req(row.org_id, "engagements.org_id"),
    orgName: req(row.org_name, "engagements.org_name"),
    projectId: req(row.project_id, "engagements.project_id"),
    projectName: req(row.project_name, "engagements.project_name"),
    roleType: req(row.role_type, "engagements.role_type"),
    roleCode: row.role_code,
    jobTitle: row.job_title,
    personId: row.person_id,
    accountId: row.account_id,
    payBasis: row.pay_basis,
    arrangement: row.arrangement,
    rateMinor: row.rate_minor,
    rateCurrency: row.rate_currency_code,
    startDate: req(row.start_date, "engagements.start_date"),
    endDate: row.end_date,
    state: req(row.engagement_state, "engagements.engagement_state"),
    areas: (row.areas ?? []) as EngagementArea[],
    projectTimeZone: req(row.project_time_zone, "engagements.project_time_zone"),
    rosterLocksAt: row.roster_locks_at,
  };
}

/** Engagements the caller holds, their account holds or a represented artist holds, by start date. */
export async function listMyEngagements(db: XosClient): Promise<Result<Engagement[]>> {
  const { data, error } = await external(db)
    .from("engagements")
    .select(ENGAGEMENT_COLUMNS)
    .order("start_date", { ascending: true });
  if (error) return fail(toDataError(error));
  return ok(data.map(toEngagement));
}

/**
 * The distinct role types of the engagements open to the caller, for navigation that depends on
 * whether the person is ever paid (Gateway's paid-work condition, finding A59-033).
 */
export async function listMyEngagementRoleTypes(
  db: XosClient,
): Promise<Result<Engagement["roleType"][]>> {
  const { data, error } = await external(db).from("engagements").select("role_type");
  if (error) return fail(toDataError(error));
  const types = new Set<Engagement["roleType"]>();
  for (const row of data) if (row.role_type) types.add(row.role_type);
  return ok([...types]);
}

/** One engagement, or not-found when it is not open to the caller. */
export async function getEngagement(db: XosClient, id: string): Promise<Result<Engagement>> {
  const { data, error } = await external(db)
    .from("engagements")
    .select(ENGAGEMENT_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  return ok(toEngagement(data));
}

/** Engagement states that count as current work (Section 4.4.4 stages 6 to 8). */
export const CURRENT_ENGAGEMENT_STATES: readonly EngagementState[] = [
  "Onboarding",
  "Blocked",
  "Active",
  "Closing",
];

export function isCurrentEngagement(e: Pick<Engagement, "state">): boolean {
  return CURRENT_ENGAGEMENT_STATES.includes(e.state);
}

// Engagement documents -------------------------------------------------------------------------

export interface EngagementDocument {
  readonly id: string;
  readonly engagementId: string;
  readonly kind: EngagementDocumentKind;
  readonly title: string;
  readonly documentId: string | null;
  readonly expiresOn: string | null;
  readonly state: EngagementDocumentState;
}

function toDocument(row: ExternalRow<"engagement_documents">): EngagementDocument {
  return {
    id: req(row.id, "engagement_documents.id"),
    engagementId: req(row.engagement_id, "engagement_documents.engagement_id"),
    kind: req(row.document_kind, "engagement_documents.document_kind"),
    title: req(row.title, "engagement_documents.title"),
    documentId: row.document_id,
    expiresOn: row.expires_on,
    state: req(row.engagement_document_state, "engagement_documents.engagement_document_state"),
  };
}

/** Documents of the caller's engagements while the documents area is open; one engagement or all. */
export async function listEngagementDocuments(
  db: XosClient,
  engagementId?: string,
): Promise<Result<EngagementDocument[]>> {
  let query = external(db)
    .from("engagement_documents")
    .select(
      "id, engagement_id, document_kind, title, document_id, expires_on, engagement_document_state",
    );
  if (engagementId !== undefined) query = query.eq("engagement_id", engagementId);
  const { data, error } = await query.order("title", { ascending: true });
  if (error) return fail(toDataError(error));
  return ok(data.map(toDocument));
}

/** The party signs a Sent document (Sent to Signed, app.sign_engagement_document). */
export async function signEngagementDocument(
  db: XosClient,
  documentId: string,
): Promise<Result<null>> {
  const { error } = await db.rpc("sign_engagement_document", { p_document_id: documentId });
  return error ? fail(toDataError(error)) : ok(null);
}

/** Documents waiting for the party's signature. */
export function awaitingSignature(docs: readonly EngagementDocument[]): EngagementDocument[] {
  return docs.filter((d) => d.state === "Sent");
}

// Onboarding ---------------------------------------------------------------------------------------

export interface OnboardingItem {
  readonly id: string;
  readonly engagementId: string;
  readonly name: string;
  readonly kind: OnboardingItemKind;
  readonly blocking: boolean;
  readonly verification: VerificationMethod;
  readonly submittedAt: string | null;
  readonly latestOutcome: VerificationOutcome | null;
  readonly expiresOn: string | null;
  readonly passes: boolean;
  /** True when the item passes, or a verified item from an earlier engagement carries over. */
  readonly satisfied: boolean;
}

/** Where an onboarding item stands for the person, derived from the view's facts. */
export type OnboardingStanding = "verified" | "review" | "todo" | "expired";

export function onboardingStanding(item: OnboardingItem, today: string): OnboardingStanding {
  if (item.expiresOn !== null && item.expiresOn < today && item.latestOutcome === "Passed") {
    return "expired";
  }
  if (item.satisfied) return "verified";
  if (item.submittedAt !== null && item.latestOutcome !== "Failed") return "review";
  return "todo";
}

function toOnboardingItem(row: ExternalRow<"onboarding_items">): OnboardingItem {
  return {
    id: req(row.id, "onboarding_items.id"),
    engagementId: req(row.engagement_id, "onboarding_items.engagement_id"),
    name: req(row.name, "onboarding_items.name"),
    kind: req(row.item_kind, "onboarding_items.item_kind"),
    blocking: row.is_blocking ?? false,
    verification: req(row.verification_method, "onboarding_items.verification_method"),
    submittedAt: row.submitted_at,
    latestOutcome: row.latest_outcome,
    expiresOn: row.expires_on,
    passes: row.passes ?? false,
    satisfied: row.satisfied ?? false,
  };
}

/** Onboarding packet items of one engagement, or of every engagement whose onboarding is open. */
export async function listOnboardingItems(
  db: XosClient,
  engagementId?: string,
): Promise<Result<OnboardingItem[]>> {
  let query = external(db)
    .from("onboarding_items")
    .select(
      "id, engagement_id, name, item_kind, is_blocking, verification_method, submitted_at, latest_outcome, expires_on, passes, satisfied",
    );
  if (engagementId !== undefined) query = query.eq("engagement_id", engagementId);
  const { data, error } = await query.order("name", { ascending: true });
  if (error) return fail(toDataError(error));
  const items = data.map(toOnboardingItem);
  return ok(items.sort((a, b) => Number(b.blocking) - Number(a.blocking)));
}

/** The party submits an onboarding item (app.submit_onboarding_item). */
export async function submitOnboardingItem(
  db: XosClient,
  itemId: string,
  documentId?: string,
): Promise<Result<null>> {
  const { error } = await db.rpc("submit_onboarding_item", {
    p_item_id: itemId,
    ...(documentId ? { p_document_id: documentId } : {}),
  });
  return error ? fail(toDataError(error)) : ok(null);
}

/** Gives an org a tax form through the secure path (app.submit_tax_form); returns the form id. */
export async function submitTaxForm(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly formKind: TaxFormKind;
    readonly tin: string;
    readonly accountId?: string | null;
    readonly foreignPerformerWithholding?: boolean;
  },
): Promise<Result<{ taxFormId: string }>> {
  const { data, error } = await db.rpc("submit_tax_form", {
    p_org_id: input.orgId,
    p_form_kind: input.formKind,
    p_tin: input.tin,
    ...(input.accountId ? { p_account_id: input.accountId } : {}),
    p_foreign_performer_withholding: input.foreignPerformerWithholding ?? false,
  });
  if (error) return fail(toDataError(error));
  return ok({ taxFormId: data });
}

// Threads and messages -------------------------------------------------------------------------------

export interface Thread {
  readonly id: string;
  readonly key: string;
  readonly engagementId: string;
  readonly subject: string;
  readonly createdAt: string;
}

export interface Message {
  readonly id: string;
  readonly threadId: string;
  readonly authorPersonId: string | null;
  readonly authorName: string | null;
  readonly body: string;
  readonly sentAt: string;
}

function toThread(row: ExternalRow<"engagement_threads">): Thread {
  const id = req(row.id, "engagement_threads.id");
  return {
    id,
    key: toDisplayKey("thread", id),
    engagementId: req(row.engagement_id, "engagement_threads.engagement_id"),
    subject: req(row.subject, "engagement_threads.subject"),
    createdAt: req(row.created_at, "engagement_threads.created_at"),
  };
}

/** Threads of the caller's engagements, newest first; one engagement or all. */
export async function listThreads(db: XosClient, engagementId?: string): Promise<Result<Thread[]>> {
  let query = external(db)
    .from("engagement_threads")
    .select("id, engagement_id, subject, created_at");
  if (engagementId !== undefined) query = query.eq("engagement_id", engagementId);
  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(data.map(toThread));
}

/** One thread, or not-found when its engagement is not open to the caller. */
export async function getThread(db: XosClient, id: string): Promise<Result<Thread>> {
  const { data, error } = await external(db)
    .from("engagement_threads")
    .select("id, engagement_id, subject, created_at")
    .eq("id", id)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  return ok(toThread(data));
}

/** Messages of the given threads, oldest first. */
export async function listMessages(
  db: XosClient,
  threadIds: readonly string[],
): Promise<Result<Message[]>> {
  if (threadIds.length === 0) return ok([]);
  const { data, error } = await external(db)
    .from("engagement_messages")
    .select("id, engagement_thread_id, author_person_id, author_name, body, sent_at")
    .in("engagement_thread_id", threadIds)
    .order("sent_at", { ascending: true });
  if (error) return fail(toDataError(error));
  return ok(
    data.map((row) => ({
      id: req(row.id, "engagement_messages.id"),
      threadId: req(row.engagement_thread_id, "engagement_messages.engagement_thread_id"),
      authorPersonId: row.author_person_id,
      authorName: row.author_name,
      body: req(row.body, "engagement_messages.body"),
      sentAt: req(row.sent_at, "engagement_messages.sent_at"),
    })),
  );
}

/** Opens a thread on an engagement whose engagement area is open (0740 write policy). */
export async function openThread(
  db: XosClient,
  input: { readonly engagementId: string; readonly subject: string },
): Promise<Result<{ threadId: string }>> {
  const { data, error } = await db
    .from("engagement_threads")
    .insert(
      derivedRow<"engagement_threads">({
        engagement_id: input.engagementId,
        subject: input.subject.trim(),
      }),
    )
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ threadId: data.id });
}

/** Posts a message; the author and time are stamped by the database (0740). */
export async function sendMessage(
  db: XosClient,
  input: { readonly threadId: string; readonly body: string },
): Promise<Result<null>> {
  const { error } = await db.from("engagement_messages").insert(
    derivedRow<"engagement_messages">({
      engagement_thread_id: input.threadId,
      body: input.body.trim(),
    }),
  );
  return error ? fail(toDataError(error)) : ok(null);
}

// Shared records ---------------------------------------------------------------------------------------

export interface SharedRecord {
  readonly id: string;
  readonly projectId: string;
  readonly kind: RecordKind;
  readonly subtype: string | null;
  readonly state: RecordState;
  readonly title: string;
  readonly startsAt: string | null;
  /** True while the start is an estimate to be confirmed: Gateway shows TBC, not the time. */
  readonly startTbc: boolean;
  readonly endsAt: string | null;
  readonly dueAt: string | null;
  readonly timeZone: string | null;
}

/**
 * Records shared with the caller's role type, person or organization on projects where they hold
 * an Active or Closing engagement (api_external.records), by the first date they carry.
 */
export async function listSharedRecords(
  db: XosClient,
  filter: { readonly projectIds?: readonly string[]; readonly kinds?: readonly RecordKind[] } = {},
): Promise<Result<SharedRecord[]>> {
  if (filter.projectIds?.length === 0) return ok([]);
  let query = external(db)
    .from("records")
    .select(
      "id, project_id, record_kind, record_subtype, record_state, title, starts_at, start_tbc, ends_at, due_at, time_zone",
    );
  if (filter.projectIds) query = query.in("project_id", filter.projectIds);
  if (filter.kinds) query = query.in("record_kind", filter.kinds);
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  const records = data.map((row): SharedRecord => ({
    id: req(row.id, "records.id"),
    projectId: req(row.project_id, "records.project_id"),
    kind: req(row.record_kind, "records.record_kind"),
    subtype: row.record_subtype,
    state: req(row.record_state, "records.record_state"),
    title: req(row.title, "records.title"),
    startsAt: row.starts_at,
    startTbc: row.start_tbc === true,
    endsAt: row.ends_at,
    dueAt: row.due_at,
    timeZone: row.time_zone,
  }));
  return ok(records.sort((a, b) => recordDate(a).localeCompare(recordDate(b))));
}

/** The date a record is placed on: its start, else its due date, else its end. */
export function recordDate(r: Pick<SharedRecord, "startsAt" | "dueAt" | "endsAt">): string {
  return r.startsAt ?? r.dueAt ?? r.endsAt ?? "9999-12-31";
}

// Money -------------------------------------------------------------------------------------------

export interface Payment {
  readonly id: string;
  readonly key: string;
  readonly orgId: string;
  readonly orgName: string;
  /** The account paid; null for a payment to the caller as an individual (A38-007). */
  readonly accountId: string | null;
  readonly amountMinor: number;
  readonly currency: string;
  readonly paidOn: string | null;
  readonly reference: string | null;
  readonly state: PaymentState;
}

/** Payments orgs made to the caller's accounts (Account Owner, Admin or Finance), newest first. */
export async function listPayments(db: XosClient): Promise<Result<Payment[]>> {
  const { data, error } = await external(db)
    .from("payments")
    .select(
      "id, org_id, org_name, account_id, amount_minor, currency_code, paid_on, reference_identifier, payment_state",
    )
    .order("paid_on", { ascending: false, nullsFirst: true });
  if (error) return fail(toDataError(error));
  return ok(
    data.map((row) => {
      const id = req(row.id, "payments.id");
      return {
        id,
        key: toDisplayKey("payment", id),
        orgId: req(row.org_id, "payments.org_id"),
        orgName: req(row.org_name, "payments.org_name"),
        accountId: row.account_id,
        amountMinor: req(row.amount_minor, "payments.amount_minor"),
        currency: req(row.currency_code, "payments.currency_code"),
        paidOn: row.paid_on,
        reference: row.reference_identifier,
        state: req(row.payment_state, "payments.payment_state"),
      };
    }),
  );
}

/** Totals per currency; money is never added across currencies (Section 3.11). */
export function totalsByCurrency(
  rows: readonly { readonly amountMinor: number; readonly currency: string }[],
): { currency: string; amountMinor: number }[] {
  const sums = new Map<string, number>();
  for (const r of rows) sums.set(r.currency, (sums.get(r.currency) ?? 0) + r.amountMinor);
  return [...sums]
    .map(([currency, amountMinor]) => ({ currency, amountMinor }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

export interface TaxForm {
  readonly id: string;
  readonly orgId: string;
  readonly orgName: string;
  readonly personId: string | null;
  readonly accountId: string | null;
  readonly kind: TaxFormKind;
  readonly tinLast4: string;
  readonly foreignPerformerWithholding: boolean;
  readonly signedAt: string;
}

/** The caller's own tax forms and their accounts', newest first; only the last four ever show. */
export async function listTaxForms(db: XosClient): Promise<Result<TaxForm[]>> {
  const { data, error } = await external(db)
    .from("tax_forms")
    .select(
      "id, org_id, org_name, person_id, account_id, form_kind, tin_last4, foreign_performer_withholding, signed_at",
    )
    .order("signed_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(
    data.map((row) => ({
      id: req(row.id, "tax_forms.id"),
      orgId: req(row.org_id, "tax_forms.org_id"),
      orgName: req(row.org_name, "tax_forms.org_name"),
      personId: row.person_id,
      accountId: row.account_id,
      kind: req(row.form_kind, "tax_forms.form_kind"),
      tinLast4: req(row.tin_last4, "tax_forms.tin_last4"),
      foreignPerformerWithholding: row.foreign_performer_withholding ?? false,
      signedAt: req(row.signed_at, "tax_forms.signed_at"),
    })),
  );
}

export interface PayoutAccount {
  readonly id: string;
  readonly orgId: string;
  readonly personId: string | null;
  readonly accountId: string | null;
  readonly provider: PayoutProvider;
  readonly last4: string | null;
}

/** Where each org pays the caller: provider and last four only. */
export async function listPayoutAccounts(db: XosClient): Promise<Result<PayoutAccount[]>> {
  const { data, error } = await external(db)
    .from("payout_accounts")
    .select("id, org_id, person_id, account_id, provider, account_last4");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((row) => ({
      id: req(row.id, "payout_accounts.id"),
      orgId: req(row.org_id, "payout_accounts.org_id"),
      personId: row.person_id,
      accountId: row.account_id,
      provider: req(row.provider, "payout_accounts.provider"),
      last4: row.account_last4,
    })),
  );
}

// Accounts ------------------------------------------------------------------------------------------

export interface ExternalAccount {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly organizationType: string;
  readonly roles: readonly AccountRole[];
}

/** Account roles in their Section 4.4.1 order, strongest first. */
export const ACCOUNT_ROLE_ORDER: readonly AccountRole[] = [
  "Account Owner",
  "Account Admin",
  "Account Finance",
  "Account Member",
];

/** The strongest of the roles held, for navigation standing; null when none is held. */
export function strongestAccountRole(roles: readonly AccountRole[]): AccountRole | null {
  return ACCOUNT_ROLE_ORDER.find((r) => roles.includes(r)) ?? null;
}

/** External accounts the caller belongs to, with their roles, by name. */
export async function listMyAccounts(db: XosClient): Promise<Result<ExternalAccount[]>> {
  const { data, error } = await external(db)
    .from("my_accounts")
    .select("account_id, name, slug, organization_type, my_roles")
    .order("name", { ascending: true });
  if (error) return fail(toDataError(error));
  return ok(
    data.map((row) => ({
      id: req(row.account_id, "my_accounts.account_id"),
      name: req(row.name, "my_accounts.name"),
      slug: req(row.slug, "my_accounts.slug"),
      organizationType: req(row.organization_type, "my_accounts.organization_type"),
      roles: ACCOUNT_ROLE_ORDER.filter((r) => (row.my_roles ?? []).includes(r)),
    })),
  );
}

/** Creates an external account with the caller as Account Owner (app.create_external_account). */
export async function createExternalAccount(
  db: XosClient,
  input: { readonly name: string; readonly slug: string },
): Promise<Result<{ accountId: string }>> {
  const { data, error } = await db.rpc("create_external_account", {
    p_name: input.name,
    p_slug: input.slug,
  });
  if (error) return fail(toDataError(error));
  return ok({ accountId: data });
}

export interface AccountMember {
  readonly membershipId: string;
  readonly accountId: string;
  readonly personId: string;
  readonly fullName: string | null;
  readonly validFrom: string;
  readonly roles: readonly AccountRole[];
  /** When the member confirmed (R4); null while not confirmed. */
  readonly acceptedAt: string | null;
}

/** The roster of one account the caller belongs to, by name. */
export async function listAccountMembers(
  db: XosClient,
  accountId: string,
): Promise<Result<AccountMember[]>> {
  const { data, error } = await external(db)
    .from("account_members")
    .select(
      "account_membership_id, account_id, person_id, full_name, valid_from, valid_to, roles, accepted_at",
    )
    .eq("account_id", accountId);
  if (error) return fail(toDataError(error));
  const members = data.map((row) => ({
    membershipId: req(row.account_membership_id, "account_members.account_membership_id"),
    accountId: req(row.account_id, "account_members.account_id"),
    personId: req(row.person_id, "account_members.person_id"),
    fullName: row.full_name,
    validFrom: req(row.valid_from, "account_members.valid_from"),
    acceptedAt: row.accepted_at ?? null,
    roles: ACCOUNT_ROLE_ORDER.filter((r) => (row.roles ?? []).includes(r)),
  }));
  return ok(members.sort((a, b) => (a.fullName ?? "").localeCompare(b.fullName ?? "")));
}

/** Adds a person to an account with a role, or grants another role (app.add_account_member). */
export async function addAccountMember(
  db: XosClient,
  input: { readonly accountId: string; readonly personId: string; readonly role: AccountRole },
): Promise<Result<{ membershipId: string }>> {
  const { data, error } = await db.rpc("add_account_member", {
    p_account_id: input.accountId,
    p_person_id: input.personId,
    p_role: input.role,
  });
  if (error) return fail(toDataError(error));
  return ok({ membershipId: data });
}

/** Ends an account membership: leaving, or an Owner or Admin removing a member. */
export async function endAccountMembership(
  db: XosClient,
  membershipId: string,
): Promise<Result<null>> {
  const { error } = await db.rpc("end_account_membership", {
    p_account_membership_id: membershipId,
  });
  return error ? fail(toDataError(error)) : ok(null);
}

// Representation ------------------------------------------------------------------------------------

export interface Representation {
  readonly id: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly artistPersonId: string;
  readonly artistName: string | null;
  readonly representativePersonId: string | null;
  readonly expiresOn: string;
  readonly acceptedAt: string | null;
  readonly revokedAt: string | null;
  readonly scopes: readonly RepresentationScope[];
}

export type RepresentationStanding = "pending" | "active" | "expired" | "revoked";

export function representationStanding(r: Representation, today: string): RepresentationStanding {
  if (r.revokedAt !== null) return "revoked";
  if (r.expiresOn < today) return "expired";
  return r.acceptedAt === null ? "pending" : "active";
}

/** Representations the caller is party to: as the artist, the named agent or an account admin. */
export async function listRepresentations(db: XosClient): Promise<Result<Representation[]>> {
  const { data, error } = await external(db)
    .from("representations")
    .select(
      "id, account_id, account_name, artist_person_id, artist_name, representative_person_id, expires_on, accepted_at, revoked_at, scopes",
    )
    .order("expires_on", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(
    data.map((row) => ({
      id: req(row.id, "representations.id"),
      accountId: req(row.account_id, "representations.account_id"),
      accountName: req(row.account_name, "representations.account_name"),
      artistPersonId: req(row.artist_person_id, "representations.artist_person_id"),
      artistName: row.artist_name,
      representativePersonId: row.representative_person_id,
      expiresOn: req(row.expires_on, "representations.expires_on"),
      acceptedAt: row.accepted_at,
      revokedAt: row.revoked_at,
      scopes: (row.scopes ?? []) as RepresentationScope[],
    })),
  );
}

/** An Owner or Admin of an agency proposes to represent an artist (app.propose_representation). */
export async function proposeRepresentation(
  db: XosClient,
  input: {
    readonly accountId: string;
    readonly artistPersonId: string;
    readonly representativePersonId: string | null;
    readonly expiresOn: string;
    readonly scopes: readonly RepresentationScope[];
  },
): Promise<Result<{ representationId: string }>> {
  const { data, error } = await db.rpc("propose_representation", {
    p_account_id: input.accountId,
    p_artist_person_id: input.artistPersonId,
    // The RPC takes NULL to let every Owner and Admin act; the generated type omits null.
    p_representative_person_id: input.representativePersonId as string,
    p_expires_on: input.expiresOn,
    p_scopes: [...input.scopes],
  });
  if (error) return fail(toDataError(error));
  return ok({ representationId: data });
}

/** The artist accepts a pending representation. */
export async function acceptRepresentation(db: XosClient, id: string): Promise<Result<null>> {
  const { error } = await db.rpc("accept_representation", { p_representation_id: id });
  return error ? fail(toDataError(error)) : ok(null);
}

/** The artist or the representing account revokes a representation at once. */
export async function revokeRepresentation(db: XosClient, id: string): Promise<Result<null>> {
  const { error } = await db.rpc("revoke_representation", { p_representation_id: id });
  return error ? fail(toDataError(error)) : ok(null);
}

// Profile shares --------------------------------------------------------------------------------

/** Gives an org a consent snapshot of chosen profile fields (app.share_profile); returns the id. */
export async function shareProfile(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly fields: readonly { readonly key: string; readonly value: string }[];
    readonly accountId?: string | null;
    readonly engagementId?: string | null;
  },
): Promise<Result<{ profileShareId: string }>> {
  const { data, error } = await db.rpc("share_profile", {
    p_org_id: input.orgId,
    p_field_keys: input.fields.map((f) => f.key),
    p_field_values: input.fields.map((f) => f.value),
    ...(input.accountId ? { p_account_id: input.accountId } : {}),
    ...(input.engagementId ? { p_engagement_id: input.engagementId } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok({ profileShareId: data });
}

/** The owner revokes a share; future updates stop and the org keeps its retained snapshot. */
export async function revokeProfileShare(db: XosClient, id: string): Promise<Result<null>> {
  const { error } = await db.rpc("revoke_profile_share", { p_profile_share_id: id });
  return error ? fail(toDataError(error)) : ok(null);
}

// Availability -------------------------------------------------------------------------------------

export interface AvailabilityBlock {
  readonly id: string;
  readonly personId: string;
  readonly calendarId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly kind: AvailabilityKind;
}

/** Availability periods of one person that the caller may see, by start. */
export async function listAvailability(
  db: XosClient,
  personId: string,
): Promise<Result<AvailabilityBlock[]>> {
  const { data, error } = await external(db)
    .from("availability")
    .select("id, person_id, availability_calendar_id, starts_at, ends_at, availability_kind")
    .eq("person_id", personId)
    .order("starts_at", { ascending: true });
  if (error) return fail(toDataError(error));
  return ok(
    data.map((row) => ({
      id: req(row.id, "availability.id"),
      personId: req(row.person_id, "availability.person_id"),
      calendarId: req(row.availability_calendar_id, "availability.availability_calendar_id"),
      startsAt: req(row.starts_at, "availability.starts_at"),
      endsAt: req(row.ends_at, "availability.ends_at"),
      kind: req(row.availability_kind, "availability.availability_kind"),
    })),
  );
}

/** Creates the caller's marketplace availability calendar; returns its id. */
export async function createAvailabilityCalendar(
  db: XosClient,
  input: {
    readonly personId: string;
    readonly timeZone: string;
    readonly visibility: AvailabilityVisibility;
  },
): Promise<Result<{ calendarId: string }>> {
  const { data, error } = await db
    .from("availability_calendars")
    .insert({ person_id: input.personId, time_zone: input.timeZone, visibility: input.visibility })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ calendarId: data.id });
}

/** Adds a block to one of the caller's calendars. */
export async function addAvailabilityBlock(
  db: XosClient,
  input: {
    readonly calendarId: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly kind: AvailabilityKind;
  },
): Promise<Result<null>> {
  const { error } = await db.from("availability_blocks").insert({
    availability_calendar_id: input.calendarId,
    starts_at: input.startsAt,
    ends_at: input.endsAt,
    availability_kind: input.kind,
  });
  return error ? fail(toDataError(error)) : ok(null);
}

/** Removes a block from the caller's calendar (soft delete, Section 7.1). */
export async function removeAvailabilityBlock(db: XosClient, id: string): Promise<Result<null>> {
  const { error } = await db
    .from("availability_blocks")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  return error ? fail(toDataError(error)) : ok(null);
}

// Ratings -------------------------------------------------------------------------------------------

export interface Rating {
  readonly id: string;
  readonly side: "Organization" | "Party";
  readonly score: number;
  readonly comment: string | null;
  readonly submittedAt: string;
  readonly ratedPersonId: string | null;
  readonly ratedOrganizationId: string | null;
  readonly raterOrganizationId: string | null;
  readonly reply: string | null;
  readonly repliedAt: string | null;
}

/** Released ratings about a person or an organization, newest first. */
export async function listRatingsAbout(
  db: XosClient,
  subject: { readonly personId: string } | { readonly organizationId: string },
): Promise<Result<Rating[]>> {
  let query = external(db)
    .from("ratings")
    .select(
      "id, rater_side, score, comment, submitted_at, rated_person_id, rated_organization_id, rater_organization_id, reply, replied_at",
    );
  query =
    "personId" in subject
      ? query.eq("rated_person_id", subject.personId)
      : query.eq("rated_organization_id", subject.organizationId);
  const { data, error } = await query.order("submitted_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(
    data.map((row) => ({
      id: req(row.id, "ratings.id"),
      side: req(row.rater_side, "ratings.rater_side"),
      score: req(row.score, "ratings.score"),
      comment: row.comment,
      submittedAt: req(row.submitted_at, "ratings.submitted_at"),
      ratedPersonId: row.rated_person_id,
      ratedOrganizationId: row.rated_organization_id,
      raterOrganizationId: row.rater_organization_id,
      reply: row.reply,
      repliedAt: row.replied_at,
    })),
  );
}

/** The mean score of released ratings to one decimal; null when there are none (never zero). */
export function averageScore(ratings: readonly Pick<Rating, "score">[]): number | null {
  if (ratings.length === 0) return null;
  const mean = ratings.reduce((sum, r) => sum + r.score, 0) / ratings.length;
  return Math.round(mean * 10) / 10;
}

/** The party rates the org on a completed engagement; both release together (0740). */
export async function rateEngagement(
  db: XosClient,
  input: { readonly engagementId: string; readonly score: number; readonly comment: string | null },
): Promise<Result<null>> {
  const { error } = await db.from("ratings").insert(
    derivedRow<"ratings">({
      engagement_id: input.engagementId,
      rater_side: "Party",
      score: input.score,
      comment: input.comment && input.comment.trim().length > 0 ? input.comment.trim() : null,
    }),
  );
  return error ? fail(toDataError(error)) : ok(null);
}

/** The rated side replies publicly to a released rating, once. */
export async function replyToRating(
  db: XosClient,
  input: { readonly ratingId: string; readonly body: string },
): Promise<Result<null>> {
  const { error } = await db
    .from("rating_replies")
    .insert(derivedRow<"rating_replies">({ rating_id: input.ratingId, body: input.body.trim() }));
  return error ? fail(toDataError(error)) : ok(null);
}
