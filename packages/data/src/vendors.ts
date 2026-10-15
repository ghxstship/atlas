import type { Database, XosClient } from "./client.ts";
import {
  blankToNull,
  deletedNow,
  insertedId,
  readOne,
  readRows,
  rpcValue,
  touched,
  type Transition,
} from "./commercial-common.ts";
import { fail, ok, type Result } from "./result.ts";

/**
 * Vendors repository (Section 4.2 Vendors, Section 7.4): the vendor facet of a counterparty with
 * its lifecycle, classes, prequalifications, insurance certificates, scorecards, sponsor
 * entitlements and masked bank accounts (migration 0330). Reads go through row level security;
 * lifecycle moves and decisions go through A03's RPCs, which refuse with XR001.
 */

type Tables = Database["app"]["Tables"];
export type VendorState = Database["app"]["Enums"]["vendor_state"];
export type ApprovalDecision = Database["app"]["Enums"]["approval_decision"];

export const VENDOR_STATES: readonly VendorState[] = [
  "Prospect",
  "Onboarded",
  "Active",
  "Blocked",
  "Canceled",
];

/** A lifecycle rule as the database states it. */
export interface TransitionRule<S extends string = string> {
  readonly from: S;
  readonly to: S;
}

/** Allowed moves of one lifecycle (app.lifecycle_transition_rules). */
export async function listTransitionRules<S extends string>(
  db: XosClient,
  lifecycle: string,
): Promise<Result<TransitionRule<S>[]>> {
  return readRows(
    db.from("lifecycle_transition_rules").select("from_state, to_state").eq("lifecycle", lifecycle),
    (row) => ({ from: row.from_state as S, to: row.to_state as S }),
  );
}

// Vendors ------------------------------------------------------------------------------------------

export interface Vendor {
  readonly id: string;
  readonly counterpartyId: string;
  /** The company's name from its one home on app.organizations; null when hidden. */
  readonly name: string | null;
  readonly counterpartyType: string | null;
  readonly state: VendorState;
  readonly paymentTermsDays: number | null;
  readonly defaultCurrencyCode: string | null;
  readonly classIds: readonly string[];
  readonly createdAt: string;
  readonly createdBy: string | null;
}

const VENDOR_COLUMNS =
  "id, counterparty_id, vendor_state, payment_terms_days, default_currency_code, created_at, created_by, counterparty:counterparties!inner(counterparty_name, counterparty_type), vendor_class_assignments(vendor_class_id, deleted_at)" as const;

interface VendorRow {
  id: string;
  counterparty_id: string;
  vendor_state: VendorState;
  payment_terms_days: number | null;
  default_currency_code: string | null;
  created_at: string;
  created_by: string | null;
  counterparty: { counterparty_name: string | null; counterparty_type: string | null } | null;
  vendor_class_assignments: { vendor_class_id: string; deleted_at: string | null }[] | null;
}

function toVendor(row: VendorRow): Vendor {
  return {
    id: row.id,
    counterpartyId: row.counterparty_id,
    name: row.counterparty?.counterparty_name ?? null,
    counterpartyType: row.counterparty?.counterparty_type ?? null,
    state: row.vendor_state,
    paymentTermsDays: row.payment_terms_days,
    defaultCurrencyCode: row.default_currency_code,
    classIds: (row.vendor_class_assignments ?? [])
      .filter((a) => a.deleted_at === null)
      .map((a) => a.vendor_class_id),
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

function byName<T extends { name: string | null }>(items: T[]): T[] {
  return items.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
}

/** Vendors of the org, by name. */
export async function listVendors(db: XosClient, orgId: string): Promise<Result<Vendor[]>> {
  const result = await readRows(
    db.from("vendors").select(VENDOR_COLUMNS).eq("org_id", orgId).is("deleted_at", null),
    (row) => toVendor(row),
  );
  return result.ok ? ok(byName(result.data)) : result;
}

export async function getVendor(db: XosClient, id: string): Promise<Result<Vendor>> {
  return readOne(
    db.from("vendors").select(VENDOR_COLUMNS).eq("id", id).is("deleted_at", null).maybeSingle(),
    (row) => toVendor(row),
  );
}

/** Counterparties of the org that have no vendor facet yet, for linking a new vendor. */
export async function listCounterpartiesWithoutVendor(
  db: XosClient,
  orgId: string,
): Promise<Result<{ id: string; name: string | null; counterpartyType: string | null }[]>> {
  const result = await readRows(
    db
      .from("counterparties")
      .select("id, counterparty_name, counterparty_type, vendors(id, deleted_at)")
      .eq("org_id", orgId)
      .is("deleted_at", null),
    (row) => ({
      id: row.id,
      name: row.counterparty_name,
      counterpartyType: row.counterparty_type,
      hasVendor: (row.vendors ?? []).some((v) => v.deleted_at === null),
    }),
  );
  if (!result.ok) return result;
  return ok(
    byName(
      result.data
        .filter((c) => !c.hasVendor)
        .map(({ id, name, counterpartyType }) => ({ id, name, counterpartyType })),
    ),
  );
}

export interface VendorInput {
  readonly orgId: string;
  /** Link an existing counterparty; otherwise a new company is recorded under `name`. */
  readonly counterpartyId?: string | null;
  readonly name?: string | null;
  readonly counterpartyType?: string | null;
  readonly paymentTermsDays?: number | null;
  readonly defaultCurrencyCode?: string | null;
}

/**
 * Creates a vendor in the Prospect state. A new company is first recorded as a counterparty
 * through app.create_counterparty (which creates its organization identity row); an existing
 * counterparty is linked as it is.
 */
export async function createVendor(
  db: XosClient,
  input: VendorInput,
): Promise<Result<{ id: string }>> {
  let counterpartyId = input.counterpartyId ?? null;
  if (counterpartyId === null) {
    const created = await rpcValue(
      db.rpc("create_counterparty", {
        p_org_id: input.orgId,
        p_name: input.name?.trim() ?? "",
        p_counterparty_type: blankToNull(input.counterpartyType) as string,
      }),
    );
    if (!created.ok) return created;
    counterpartyId = created.data;
  }
  const row = {
    counterparty_id: counterpartyId,
    payment_terms_days: input.paymentTermsDays ?? null,
    default_currency_code: blankToNull(input.defaultCurrencyCode),
  } as Tables["vendors"]["Insert"];
  return insertedId(db.from("vendors").insert(row).select("id").single());
}

/** Edits a vendor's terms and default currency. */
export async function updateVendor(
  db: XosClient,
  id: string,
  input: { readonly paymentTermsDays: number | null; readonly defaultCurrencyCode: string | null },
): Promise<Result<null>> {
  return touched(
    db
      .from("vendors")
      .update({
        payment_terms_days: input.paymentTermsDays,
        default_currency_code: blankToNull(input.defaultCurrencyCode),
      })
      .eq("id", id)
      .select("id"),
  );
}

/** Moves a vendor along its lifecycle (app.transition_vendor, compare-and-set). */
export async function transitionVendor(
  db: XosClient,
  move: Transition<VendorState>,
): Promise<Result<null>> {
  const result = await rpcValue(
    db.rpc("transition_vendor", {
      p_vendor_id: move.id,
      p_expected: move.expected,
      p_next: move.next,
      p_reason: move.reason,
    }),
  );
  return result.ok ? ok(null) : result;
}

// Vendor classes -----------------------------------------------------------------------------------

export interface VendorClass {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly stdVendorClassId: string | null;
  readonly vendorCount: number;
}

export async function listVendorClasses(
  db: XosClient,
  orgId: string,
): Promise<Result<VendorClass[]>> {
  const result = await readRows(
    db
      .from("vendor_classes")
      .select(
        "id, name, description, std_vendor_class_id, vendor_class_assignments(id, deleted_at)",
      )
      .eq("org_id", orgId)
      .is("deleted_at", null),
    (row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      stdVendorClassId: row.std_vendor_class_id,
      vendorCount: (row.vendor_class_assignments ?? []).filter((a) => a.deleted_at === null).length,
    }),
  );
  return result.ok ? ok(byName(result.data)) : result;
}

export interface VendorClassInput {
  readonly name: string;
  readonly description: string | null;
  readonly stdVendorClassId: string | null;
}

export async function createVendorClass(
  db: XosClient,
  orgId: string,
  input: VendorClassInput,
): Promise<Result<{ id: string }>> {
  return insertedId(
    db
      .from("vendor_classes")
      .insert({
        org_id: orgId,
        name: input.name.trim(),
        description: blankToNull(input.description),
        std_vendor_class_id: blankToNull(input.stdVendorClassId),
      })
      .select("id")
      .single(),
  );
}

export async function updateVendorClass(
  db: XosClient,
  id: string,
  input: VendorClassInput,
): Promise<Result<null>> {
  return touched(
    db
      .from("vendor_classes")
      .update({
        name: input.name.trim(),
        description: blankToNull(input.description),
        std_vendor_class_id: blankToNull(input.stdVendorClassId),
      })
      .eq("id", id)
      .select("id"),
  );
}

export async function deleteVendorClass(db: XosClient, id: string): Promise<Result<null>> {
  return touched(db.from("vendor_classes").update(deletedNow()).eq("id", id).select("id"));
}

/** Sets exactly the given classes on a vendor: adds the missing assignments, ends the rest. */
export async function setVendorClasses(
  db: XosClient,
  vendorId: string,
  classIds: readonly string[],
): Promise<Result<null>> {
  const current = await readRows(
    db
      .from("vendor_class_assignments")
      .select("id, vendor_class_id")
      .eq("vendor_id", vendorId)
      .is("deleted_at", null),
    (row) => row,
  );
  if (!current.ok) return current;
  const held = new Set(current.data.map((a) => a.vendor_class_id));
  const additions = classIds
    .filter((c) => !held.has(c))
    .map(
      (c) =>
        ({
          vendor_id: vendorId,
          vendor_class_id: c,
        }) as Tables["vendor_class_assignments"]["Insert"],
    );
  if (additions.length > 0) {
    const added = await readRows(
      db.from("vendor_class_assignments").insert(additions).select("id"),
      (r) => r,
    );
    if (!added.ok) return added;
  }
  const stale = current.data.filter((a) => !classIds.includes(a.vendor_class_id)).map((a) => a.id);
  if (stale.length > 0) {
    const ended = await readRows(
      db.from("vendor_class_assignments").update(deletedNow()).in("id", stale).select("id"),
      (r) => r,
    );
    if (!ended.ok) return ended;
  }
  return ok(null);
}

/** Standard Library vendor classes an org may adopt (xpms.std_vendor_class, read-only canon). */
export async function listStandardVendorClasses(
  db: XosClient,
): Promise<Result<{ id: string; name: string; description: string | null }[]>> {
  return readRows(
    db
      .schema("xpms")
      .from("std_vendor_class")
      .select("record_id, class, description")
      .order("source_row"),
    (row) => ({
      id: row.record_id,
      name: row.class ?? row.record_id,
      description: row.description,
    }),
  );
}

// Prequalifications ---------------------------------------------------------------------------------

export interface Prequalification {
  readonly id: string;
  readonly vendorId: string;
  readonly vendorName: string | null;
  readonly scopeNote: string;
  readonly decision: ApprovalDecision | null;
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
  readonly validTo: string | null;
  readonly createdAt: string;
  readonly createdBy: string | null;
}

const PREQUALIFICATION_COLUMNS =
  "id, vendor_id, scope_note, decision, decided_at, decided_by, valid_to, created_at, created_by, vendor:vendors!inner(counterparty:counterparties!inner(counterparty_name))" as const;

interface VendorNameEmbed {
  vendor: { counterparty: { counterparty_name: string | null } | null } | null;
}

function vendorName(row: VendorNameEmbed): string | null {
  return row.vendor?.counterparty?.counterparty_name ?? null;
}

export async function listPrequalifications(
  db: XosClient,
  orgId: string,
  vendorId?: string,
): Promise<Result<Prequalification[]>> {
  let query = db
    .from("prequalifications")
    .select(PREQUALIFICATION_COLUMNS)
    .eq("org_id", orgId)
    .is("deleted_at", null);
  if (vendorId) query = query.eq("vendor_id", vendorId);
  return readRows(query.order("created_at", { ascending: false }), (row) => ({
    id: row.id,
    vendorId: row.vendor_id,
    vendorName: vendorName(row as VendorNameEmbed),
    scopeNote: row.scope_note,
    decision: row.decision,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    validTo: row.valid_to,
    createdAt: row.created_at,
    createdBy: row.created_by,
  }));
}

/** Requests a prequalification; it stays pending until someone else decides it. */
export async function requestPrequalification(
  db: XosClient,
  input: { readonly vendorId: string; readonly scopeNote: string },
): Promise<Result<{ id: string }>> {
  const row = {
    vendor_id: input.vendorId,
    scope_note: input.scopeNote.trim(),
  } as Tables["prequalifications"]["Insert"];
  return insertedId(db.from("prequalifications").insert(row).select("id").single());
}

/** Decides a prequalification (app.decide_prequalification: never by its requester, final). */
export async function decidePrequalification(
  db: XosClient,
  input: {
    readonly id: string;
    readonly decision: ApprovalDecision;
    readonly validTo: string | null;
  },
): Promise<Result<null>> {
  const result = await rpcValue(
    db.rpc("decide_prequalification", {
      p_prequalification_id: input.id,
      p_decision: input.decision,
      ...(input.validTo ? { p_valid_to: input.validTo } : {}),
    }),
  );
  return result.ok ? ok(null) : result;
}

// Insurance certificates -----------------------------------------------------------------------------

export type CertificateStanding = "current" | "expiring" | "expired" | "future";

export interface InsuranceCertificate {
  readonly id: string;
  readonly vendorId: string;
  readonly vendorName: string | null;
  readonly insurer: string;
  readonly policyIdentifier: string;
  readonly coverageType: string;
  /** Per-occurrence limit in minor units; null when the certificate states none. */
  readonly coverageLimitMinor: number | null;
  readonly currencyCode: string | null;
  readonly validFrom: string;
  readonly validTo: string;
  readonly documentUri: string | null;
}

/** Days before expiry at which a current certificate counts as expiring. */
export const CERTIFICATE_EXPIRY_WINDOW_DAYS = 30;

/** Whether a certificate is current on `today` (an ISO date), derived at read time. */
export function certificateStanding(
  cert: Pick<InsuranceCertificate, "validFrom" | "validTo">,
  today: string,
): CertificateStanding {
  if (cert.validTo < today) return "expired";
  if (cert.validFrom > today) return "future";
  const days = (Date.parse(cert.validTo) - Date.parse(today)) / 86_400_000;
  return days <= CERTIFICATE_EXPIRY_WINDOW_DAYS ? "expiring" : "current";
}

const CERTIFICATE_COLUMNS =
  "id, vendor_id, insurer, policy_identifier, coverage_type, coverage_limit_minor, currency_code, valid_from, valid_to, document_uri, vendor:vendors!inner(counterparty:counterparties!inner(counterparty_name))" as const;

export async function listInsuranceCertificates(
  db: XosClient,
  orgId: string,
  vendorId?: string,
): Promise<Result<InsuranceCertificate[]>> {
  let query = db
    .from("insurance_certificates")
    .select(CERTIFICATE_COLUMNS)
    .eq("org_id", orgId)
    .is("deleted_at", null);
  if (vendorId) query = query.eq("vendor_id", vendorId);
  return readRows(query.order("valid_to"), (row) => ({
    id: row.id,
    vendorId: row.vendor_id,
    vendorName: vendorName(row as VendorNameEmbed),
    insurer: row.insurer,
    policyIdentifier: row.policy_identifier,
    coverageType: row.coverage_type,
    coverageLimitMinor: row.coverage_limit_minor,
    currencyCode: row.currency_code,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    documentUri: row.document_uri,
  }));
}

export interface InsuranceCertificateInput {
  readonly vendorId: string;
  readonly insurer: string;
  readonly policyIdentifier: string;
  readonly coverageType: string;
  readonly coverageLimitMinor: number | null;
  readonly currencyCode: string | null;
  readonly validFrom: string;
  readonly validTo: string;
  readonly documentUri: string | null;
}

function certificateRow(input: InsuranceCertificateInput) {
  return {
    vendor_id: input.vendorId,
    insurer: input.insurer.trim(),
    policy_identifier: input.policyIdentifier.trim(),
    coverage_type: input.coverageType.trim(),
    coverage_limit_minor: input.coverageLimitMinor,
    currency_code: blankToNull(input.currencyCode),
    valid_from: input.validFrom,
    valid_to: input.validTo,
    document_uri: blankToNull(input.documentUri),
  };
}

export async function createInsuranceCertificate(
  db: XosClient,
  input: InsuranceCertificateInput,
): Promise<Result<{ id: string }>> {
  const row = certificateRow(input) as Tables["insurance_certificates"]["Insert"];
  return insertedId(db.from("insurance_certificates").insert(row).select("id").single());
}

export async function updateInsuranceCertificate(
  db: XosClient,
  id: string,
  input: InsuranceCertificateInput,
): Promise<Result<null>> {
  return touched(
    db.from("insurance_certificates").update(certificateRow(input)).eq("id", id).select("id"),
  );
}

export async function deleteInsuranceCertificate(db: XosClient, id: string): Promise<Result<null>> {
  return touched(db.from("insurance_certificates").update(deletedNow()).eq("id", id).select("id"));
}

// Scorecards -----------------------------------------------------------------------------------------

export interface Scorecard {
  readonly id: string;
  readonly vendorId: string;
  readonly vendorName: string | null;
  readonly projectId: string | null;
  readonly periodEnd: string;
  readonly qualityScore: number | null;
  readonly deliveryScore: number | null;
  readonly safetyScore: number | null;
  readonly note: string | null;
}

/** Mean of the scored dimensions; null when none is scored (never zero). */
export function scorecardAverage(
  card: Pick<Scorecard, "qualityScore" | "deliveryScore" | "safetyScore">,
): number | null {
  const scores = [card.qualityScore, card.deliveryScore, card.safetyScore].filter(
    (s): s is number => s !== null,
  );
  if (scores.length === 0) return null;
  return Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;
}

export async function listScorecards(
  db: XosClient,
  orgId: string,
  vendorId?: string,
): Promise<Result<Scorecard[]>> {
  let query = db
    .from("vendor_scorecards")
    .select(
      "id, vendor_id, project_id, period_end, quality_score, delivery_score, safety_score, note, vendor:vendors!inner(counterparty:counterparties!inner(counterparty_name))",
    )
    .eq("org_id", orgId)
    .is("deleted_at", null);
  if (vendorId) query = query.eq("vendor_id", vendorId);
  return readRows(query.order("period_end", { ascending: false }), (row) => ({
    id: row.id,
    vendorId: row.vendor_id,
    vendorName: vendorName(row as VendorNameEmbed),
    projectId: row.project_id,
    periodEnd: row.period_end,
    qualityScore: row.quality_score,
    deliveryScore: row.delivery_score,
    safetyScore: row.safety_score,
    note: row.note,
  }));
}

export interface ScorecardInput {
  readonly vendorId: string;
  readonly projectId: string | null;
  readonly periodEnd: string;
  readonly qualityScore: number | null;
  readonly deliveryScore: number | null;
  readonly safetyScore: number | null;
  readonly note: string | null;
}

function scorecardRow(input: ScorecardInput) {
  return {
    vendor_id: input.vendorId,
    project_id: blankToNull(input.projectId),
    period_end: input.periodEnd,
    quality_score: input.qualityScore,
    delivery_score: input.deliveryScore,
    safety_score: input.safetyScore,
    note: blankToNull(input.note),
  };
}

export async function createScorecard(
  db: XosClient,
  input: ScorecardInput,
): Promise<Result<{ id: string }>> {
  const row = scorecardRow(input) as Tables["vendor_scorecards"]["Insert"];
  return insertedId(db.from("vendor_scorecards").insert(row).select("id").single());
}

export async function updateScorecard(
  db: XosClient,
  id: string,
  input: ScorecardInput,
): Promise<Result<null>> {
  return touched(
    db.from("vendor_scorecards").update(scorecardRow(input)).eq("id", id).select("id"),
  );
}

export async function deleteScorecard(db: XosClient, id: string): Promise<Result<null>> {
  return touched(db.from("vendor_scorecards").update(deletedNow()).eq("id", id).select("id"));
}

// Sponsor entitlements ---------------------------------------------------------------------------------

export interface SponsorEntitlement {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string | null;
  readonly projectKey: string | null;
  readonly counterpartyId: string;
  readonly sponsorName: string | null;
  readonly description: string;
  readonly quantity: number | null;
  readonly dueOn: string | null;
  readonly fulfilledAt: string | null;
}

export async function listSponsorEntitlements(
  db: XosClient,
  orgId: string,
): Promise<Result<SponsorEntitlement[]>> {
  return readRows(
    db
      .from("sponsor_entitlements")
      .select(
        "id, project_id, counterparty_id, description, quantity, due_on, fulfilled_at, project:projects(name, project_key), counterparty:counterparties(counterparty_name)",
      )
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .order("due_on", { ascending: true, nullsFirst: false }),
    (row) => ({
      id: row.id,
      projectId: row.project_id,
      projectName: row.project?.name ?? null,
      projectKey: row.project?.project_key ?? null,
      counterpartyId: row.counterparty_id,
      sponsorName: row.counterparty?.counterparty_name ?? null,
      description: row.description,
      quantity: row.quantity,
      dueOn: row.due_on,
      fulfilledAt: row.fulfilled_at,
    }),
  );
}

export interface SponsorEntitlementInput {
  readonly projectId: string;
  readonly counterpartyId: string;
  readonly description: string;
  readonly quantity: number | null;
  readonly dueOn: string | null;
}

export async function createSponsorEntitlement(
  db: XosClient,
  input: SponsorEntitlementInput,
): Promise<Result<{ id: string }>> {
  const row = {
    project_id: input.projectId,
    counterparty_id: input.counterpartyId,
    description: input.description.trim(),
    quantity: input.quantity,
    due_on: blankToNull(input.dueOn),
  } as Tables["sponsor_entitlements"]["Insert"];
  return insertedId(db.from("sponsor_entitlements").insert(row).select("id").single());
}

export async function updateSponsorEntitlement(
  db: XosClient,
  id: string,
  input: Omit<SponsorEntitlementInput, "projectId">,
): Promise<Result<null>> {
  return touched(
    db
      .from("sponsor_entitlements")
      .update({
        counterparty_id: input.counterpartyId,
        description: input.description.trim(),
        quantity: input.quantity,
        due_on: blankToNull(input.dueOn),
      })
      .eq("id", id)
      .select("id"),
  );
}

/** Marks an entitlement delivered now, or owed again with `fulfilled` false. */
export async function setEntitlementFulfilled(
  db: XosClient,
  id: string,
  fulfilled: boolean,
  now: Date = new Date(),
): Promise<Result<null>> {
  return touched(
    db
      .from("sponsor_entitlements")
      .update({ fulfilled_at: fulfilled ? now.toISOString() : null })
      .eq("id", id)
      .select("id"),
  );
}

export async function deleteSponsorEntitlement(db: XosClient, id: string): Promise<Result<null>> {
  return touched(db.from("sponsor_entitlements").update(deletedNow()).eq("id", id).select("id"));
}

/** Every counterparty of the org, for sponsor and invoice pickers. */
export async function listCounterparties(
  db: XosClient,
  orgId: string,
): Promise<Result<{ id: string; name: string | null; counterpartyType: string | null }[]>> {
  const result = await readRows(
    db
      .from("counterparties")
      .select("id, counterparty_name, counterparty_type")
      .eq("org_id", orgId)
      .is("deleted_at", null),
    (row) => ({ id: row.id, name: row.counterparty_name, counterpartyType: row.counterparty_type }),
  );
  return result.ok ? ok(byName(result.data)) : result;
}

// Bank accounts (Restricted, masked) ---------------------------------------------------------------------

export interface VendorBankAccount {
  readonly id: string;
  readonly bankName: string;
  readonly accountHolder: string;
  readonly accountLast4: string;
  /** Null when masked for the viewer (Section 8.3). */
  readonly accountNumber: string | null;
  readonly routingNumber: string | null;
  readonly isMasked: boolean;
}

/** Bank accounts through app.vendor_bank_accounts_masked; Restricted numbers stay null when masked. */
export async function listVendorBankAccounts(
  db: XosClient,
  vendorId: string,
): Promise<Result<VendorBankAccount[]>> {
  return readRows(
    db
      .from("vendor_bank_accounts_masked")
      .select(
        "id, bank_name, account_holder, account_last4, account_number, routing_number, is_masked",
      )
      .eq("vendor_id", vendorId),
    (row) => ({
      id: row.id ?? "",
      bankName: row.bank_name ?? "",
      accountHolder: row.account_holder ?? "",
      accountLast4: row.account_last4 ?? "",
      accountNumber: row.account_number,
      routingNumber: row.routing_number,
      isMasked: row.is_masked ?? true,
    }),
  );
}

/** Adds a bank account; the database logs the editor for sod_vendor_payment. */
export async function addVendorBankAccount(
  db: XosClient,
  input: {
    readonly vendorId: string;
    readonly bankName: string;
    readonly accountHolder: string;
    readonly accountNumber: string;
    readonly routingNumber: string | null;
  },
): Promise<Result<{ id: string }>> {
  const compact = input.accountNumber.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (compact.length < 4) {
    return fail({ kind: "invalid", message: "account_number" });
  }
  const row = {
    vendor_id: input.vendorId,
    bank_name: input.bankName.trim(),
    account_holder: input.accountHolder.trim(),
    account_number: input.accountNumber.trim(),
    account_last4: compact.slice(-4),
    routing_number: blankToNull(input.routingNumber),
  } as Tables["vendor_bank_accounts"]["Insert"];
  return insertedId(db.from("vendor_bank_accounts").insert(row).select("id").single());
}

// Sponsor assets, deliveries and proof of performance (migration 0492) ------------------------------------------

export type SponsorAssetKind = Database["app"]["Enums"]["sponsor_asset_kind"];
export type ReviewState = Database["app"]["Enums"]["review_state"];

export const SPONSOR_ASSET_KINDS: readonly SponsorAssetKind[] = [
  "Logo",
  "Artwork",
  "Copy",
  "Video",
  "Other",
];

export interface SponsorAsset {
  readonly id: string;
  readonly entitlementId: string;
  readonly kind: SponsorAssetKind;
  readonly title: string;
  readonly usageNote: string | null;
  readonly dueOn: string | null;
  readonly revision: number;
  readonly state: ReviewState;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly createdBy: string | null;
}

export async function listSponsorAssets(
  db: XosClient,
  orgId: string,
): Promise<Result<SponsorAsset[]>> {
  return readRows(
    db
      .from("sponsor_assets")
      .select(
        "id, sponsor_entitlement_id, asset_kind, title, usage_note, due_on, revision, asset_state, decided_by, decided_at, created_by",
      )
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .order("created_at"),
    (row) => ({
      id: row.id,
      entitlementId: row.sponsor_entitlement_id,
      kind: row.asset_kind,
      title: row.title,
      usageNote: row.usage_note,
      dueOn: row.due_on,
      revision: row.revision,
      state: row.asset_state,
      decidedBy: row.decided_by,
      decidedAt: row.decided_at,
      createdBy: row.created_by,
    }),
  );
}

export async function createSponsorAsset(
  db: XosClient,
  input: {
    readonly entitlementId: string;
    readonly kind: SponsorAssetKind;
    readonly title: string;
    readonly usageNote: string | null;
    readonly dueOn: string | null;
  },
): Promise<Result<{ id: string }>> {
  const row = {
    sponsor_entitlement_id: input.entitlementId,
    asset_kind: input.kind,
    title: input.title.trim(),
    usage_note: blankToNull(input.usageNote),
    due_on: blankToNull(input.dueOn),
  } as Tables["sponsor_assets"]["Insert"];
  return insertedId(db.from("sponsor_assets").insert(row).select("id").single());
}

/** Submits, approves, returns or cancels a sponsor asset (app.transition_sponsor_asset). */
export async function transitionSponsorAsset(
  db: XosClient,
  move: Transition<ReviewState>,
): Promise<Result<null>> {
  const result = await rpcValue(
    db.rpc("transition_sponsor_asset", {
      p_sponsor_asset_id: move.id,
      p_expected: move.expected,
      p_next: move.next,
      p_reason: move.reason,
    }),
  );
  return result.ok ? ok(null) : result;
}

export interface EntitlementDelivery {
  readonly id: string;
  readonly entitlementId: string;
  readonly deliveredOn: string;
  /** Null when the delivery was not counted. */
  readonly quantityDelivered: number | null;
  readonly note: string | null;
  readonly recordedBy: string | null;
}

export async function listEntitlementDeliveries(
  db: XosClient,
  orgId: string,
): Promise<Result<EntitlementDelivery[]>> {
  return readRows(
    db
      .from("entitlement_deliveries")
      .select("id, sponsor_entitlement_id, delivered_on, quantity_delivered, note, recorded_by")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .order("delivered_on", { ascending: false }),
    (row) => ({
      id: row.id,
      entitlementId: row.sponsor_entitlement_id,
      deliveredOn: row.delivered_on,
      quantityDelivered: row.quantity_delivered,
      note: row.note,
      recordedBy: row.recorded_by,
    }),
  );
}

export async function recordEntitlementDelivery(
  db: XosClient,
  input: {
    readonly entitlementId: string;
    readonly deliveredOn: string;
    readonly quantityDelivered: number | null;
    readonly note: string | null;
  },
): Promise<Result<{ id: string }>> {
  const row = {
    sponsor_entitlement_id: input.entitlementId,
    delivered_on: input.deliveredOn,
    quantity_delivered: input.quantityDelivered,
    note: blankToNull(input.note),
  } as Tables["entitlement_deliveries"]["Insert"];
  return insertedId(db.from("entitlement_deliveries").insert(row).select("id").single());
}

export interface ProofOfPerformance {
  readonly entitlementId: string;
  readonly quantityOwed: number | null;
  readonly quantityDelivered: number | null;
  readonly deliveryCount: number;
  readonly lastDeliveredOn: string | null;
  readonly isMet: boolean;
}

/** Proof of performance per entitlement (app.sponsor_proof_of_performance, gate 8). */
export async function listProofOfPerformance(db: XosClient): Promise<Result<ProofOfPerformance[]>> {
  return readRows(
    db
      .from("sponsor_proof_of_performance")
      .select(
        "sponsor_entitlement_id, quantity_owed, quantity_delivered, delivery_count, last_delivered_on, is_met",
      ),
    (row) => ({
      entitlementId: row.sponsor_entitlement_id ?? "",
      quantityOwed: row.quantity_owed,
      quantityDelivered: row.quantity_delivered,
      deliveryCount: row.delivery_count ?? 0,
      lastDeliveredOn: row.last_delivered_on,
      isMet: row.is_met ?? false,
    }),
  );
}
