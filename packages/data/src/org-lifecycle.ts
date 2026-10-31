import { addCalendarDays, dateIn, todayIn } from "./calendar.ts";
import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import {
  bool,
  list,
  num,
  numOrNull,
  rows,
  rpc,
  str,
  strOrNull,
  type Raw,
} from "./platform-common.ts";
import { untyped } from "./untyped.ts";

/**
 * Org lifecycle beyond cancellation (A79, migrations 1350 to 1355; Section 4.6.1, Section 12, Section 14.7,
 * Section 16): the banner status every org page shows, deletion with step-up and a 7-day recovery window,
 * ownership transfer, deletion certificates, standing partner grants, leaving a partner, and custom domain
 * provisioning. Every write goes through an RPC that decides the rules; reads run with the caller's row
 * level security.
 *
 * Dates are days on the org's calendar (its locale.time_zone, A71's @xos/data/calendar), never UTC days. The
 * trial, the recovery window and an ownership offer end at the org's midnight after their whole days
 * (private.org_window_end, 1350), so the day to show is the window's last day (windowLastDay).
 */

// Banner status -------------------------------------------------------------------------------------------------

export type ReadOnlyReason = "deletion" | "canceled" | "dunning";
export type BillingState = "past_due" | "read_only";

export interface OrgBannerStatus {
  readonly readOnlyReason: ReadOnlyReason | null;
  readonly readOnlyUntil: string | null;
  readonly purgeAfter: string | null;
  readonly recoverUntil: string | null;
  readonly trialPlan: string | null;
  readonly trialEndsAt: string | null;
  readonly billingState: BillingState | null;
  readonly pastDueSince: string | null;
  readonly whiteLabelUntil: string | null;
  /** An ownership offer made to the caller, waiting for their answer. */
  readonly ownershipOffer: {
    readonly transferId: string;
    readonly offeredBy: string;
    readonly expiresAt: string;
  } | null;
  /** What plan limits made read-only (A107, 2071): the plan and how many projects, seats and field seats. */
  readonly overLimit: {
    readonly planCode: string;
    readonly projects: number;
    readonly seats: number;
    readonly fieldSeats: number;
  } | null;
  /** The limit the caller's own seat is past, when it is read-only. */
  readonly ownSeatReadOnly: OwnSeatLimit | null;
}

export type OwnSeatLimit = "seats" | "field_members";

const READ_ONLY_REASONS: readonly ReadOnlyReason[] = ["deletion", "canceled", "dunning"];
const BILLING_STATES: readonly BillingState[] = ["past_due", "read_only"];
const OWN_SEAT_LIMITS: readonly OwnSeatLimit[] = ["seats", "field_members"];

export function toBannerStatus(r: Raw | undefined): OrgBannerStatus {
  const reason = strOrNull(r?.["read_only_reason"]);
  const billing = strOrNull(r?.["billing_state"]);
  const overLimitPlan = strOrNull(r?.["over_limit_plan"]);
  const ownSeat = strOrNull(r?.["own_seat_read_only"]);
  return {
    readOnlyReason: READ_ONLY_REASONS.includes(reason as ReadOnlyReason)
      ? (reason as ReadOnlyReason)
      : null,
    readOnlyUntil: strOrNull(r?.["read_only_until"]),
    purgeAfter: strOrNull(r?.["purge_after"]),
    recoverUntil: strOrNull(r?.["recover_until"]),
    trialPlan: strOrNull(r?.["trial_plan"]),
    trialEndsAt: strOrNull(r?.["trial_ends_at"]),
    billingState: BILLING_STATES.includes(billing as BillingState)
      ? (billing as BillingState)
      : null,
    pastDueSince: strOrNull(r?.["past_due_since"]),
    whiteLabelUntil: strOrNull(r?.["white_label_until"]),
    ownershipOffer: r?.["ownership_transfer_id"]
      ? {
          transferId: str(r["ownership_transfer_id"]),
          offeredBy: str(r["ownership_offered_by"]),
          expiresAt: str(r["ownership_expires_at"]),
        }
      : null,
    overLimit: overLimitPlan
      ? {
          planCode: overLimitPlan,
          projects: num(r?.["read_only_projects"]),
          seats: num(r?.["read_only_seats"]),
          fieldSeats: num(r?.["read_only_field_seats"]),
        }
      : null,
    ownSeatReadOnly: OWN_SEAT_LIMITS.includes(ownSeat as OwnSeatLimit)
      ? (ownSeat as OwnSeatLimit)
      : null,
  };
}

/** Everything the org banners show, in one call (app.org_banner_status, 1353, 1355 and 2071). Members only. */
export function getOrgBannerStatus(db: XosClient, orgId: string): Promise<Result<OrgBannerStatus>> {
  return rpc(db, "org_banner_status", { p_org_id: orgId }, (data) =>
    toBannerStatus(((data as Raw[] | null) ?? [])[0]),
  );
}

/** Day of dunning a payment has been overdue, from when it first failed, as private.run_dunning counts (0560). */
export function daysOverdue(since: string, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / 86_400_000));
}

/** When dunning makes the org read-only: day 21 after the payment first failed (Section 16, 0560). */
export function readOnlyOn(since: string): string {
  return new Date(new Date(since).getTime() + 21 * 86_400_000).toISOString();
}

// Days on the org's calendar ------------------------------------------------------------------------------------

/** Whole days from one `YYYY-MM-DD` date to another; negative when `to` comes first. */
export function calendarDaysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** The calendar day an instant falls on in a zone (UTC for an unknown zone), as `YYYY-MM-DD`. */
export function dayOf(instant: string, zone: string | null | undefined): string {
  return dateIn(new Date(instant), zone);
}

/**
 * The last day inside a window that ends at `endsAt`, on a zone's calendar: the day before when it ends at
 * that zone's midnight, as the trial, the recovery window and an ownership offer do (1350).
 */
export function windowLastDay(endsAt: string, zone: string | null | undefined): string {
  return dateIn(new Date(Date.parse(endsAt) - 1), zone);
}

/** Whole days left in a trial on the org's calendar: 14 on the day it starts, 0 on its last day (1350). */
export function trialDaysLeft(
  trialEndsAt: string,
  zone: string | null | undefined,
  now: Date = new Date(),
): number {
  return Math.max(0, calendarDaysBetween(todayIn(zone, now), windowLastDay(trialEndsAt, zone)));
}

/** Day 90 of a cancellation on the org's calendar, counted from the day it was canceled: its data is deleted then (1351). */
export function purgeDay(canceledAt: string, zone: string | null | undefined): string {
  return addCalendarDays(dayOf(canceledAt, zone), 90);
}

// Deletion ----------------------------------------------------------------------------------------------------------

export interface DeletionRequest {
  readonly id: string;
  readonly reason: string;
  readonly requestedAt: string;
  readonly recoverUntil: string;
  readonly requestedBy: string;
}

/** The org's open deletion request, or null (app.org_deletion_requests, 1351). */
export async function getDeletionRequest(
  db: XosClient,
  orgId: string,
): Promise<Result<DeletionRequest | null>> {
  const result = await rows(
    untyped(db)
      .from("org_deletion_requests")
      .select("id, reason, requested_at, recover_until, requested_by")
      .eq("org_id", orgId)
      .is("recovered_at", null)
      .is("deleted_at", null)
      .limit(1),
  );
  if (!result.ok) return result;
  const r = result.data[0];
  return ok(
    r
      ? {
          id: str(r["id"]),
          reason: str(r["reason"]),
          requestedAt: str(r["requested_at"]),
          recoverUntil: str(r["recover_until"]),
          requestedBy: str(r["requested_by"]),
        }
      : null,
  );
}

/** Asks to delete the org: the Owner, step-up and the typed name (app.request_org_deletion). */
export function requestOrgDeletion(
  db: XosClient,
  input: { orgId: string; confirmName: string; reason: string },
): Promise<Result<string>> {
  return rpc(
    db,
    "request_org_deletion",
    { p_org_id: input.orgId, p_confirm_name: input.confirmName, p_reason: input.reason },
    str,
  );
}

/** Recovers the org within the 7-day window (app.recover_org_deletion). */
export function recoverOrgDeletion(db: XosClient, orgId: string): Promise<Result<string>> {
  return rpc(db, "recover_org_deletion", { p_org_id: orgId }, str);
}

export interface DeletionCertificate {
  readonly id: string;
  readonly deletedOrgId: string;
  readonly orgName: string;
  readonly orgSlug: string;
  readonly basis: "cancellation" | "deletion_request";
  readonly requestedAt: string;
  readonly dueAt: string;
  readonly purgedAt: string | null;
  readonly tablesPurged: number | null;
  readonly rowsPurged: number | null;
  readonly storageObjectsDeleted: number;
  readonly issuedAt: string | null;
  readonly documentObject: string | null;
  readonly documentSha256: string | null;
  readonly deliveredAt: string | null;
  /** The deleted org's time zone, the calendar its certificate dates the deletion on. */
  readonly timeZone: string;
}

/** Private bucket of certificate PDFs; the former Owner reads their own (1351). */
export const DELETION_CERTIFICATES_BUCKET = "deletion-certificates";

export const CERTIFICATE_COLUMNS =
  "id, deleted_org_id, org_name, org_slug, basis, requested_at, due_at, purged_at, tables_purged, rows_purged, storage_objects_deleted, issued_at, document_object, document_sha256, delivered_at, time_zone";

export function toCertificate(r: Raw): DeletionCertificate {
  return {
    id: str(r["id"]),
    deletedOrgId: str(r["deleted_org_id"]),
    orgName: str(r["org_name"]),
    orgSlug: str(r["org_slug"]),
    basis: str(r["basis"]) === "deletion_request" ? "deletion_request" : "cancellation",
    requestedAt: str(r["requested_at"]),
    dueAt: str(r["due_at"]),
    purgedAt: strOrNull(r["purged_at"]),
    tablesPurged: numOrNull(r["tables_purged"]),
    rowsPurged: numOrNull(r["rows_purged"]),
    storageObjectsDeleted: num(r["storage_objects_deleted"]),
    issuedAt: strOrNull(r["issued_at"]),
    documentObject: strOrNull(r["document_object"]),
    documentSha256: strOrNull(r["document_sha256"]),
    deliveredAt: strOrNull(r["delivered_at"]),
    timeZone: strOrNull(r["time_zone"]) ?? "UTC",
  };
}

/** The signed-in person's deletion certificates, newest first: orgs they owned that were deleted. */
export async function listMyDeletionCertificates(
  db: XosClient,
): Promise<Result<DeletionCertificate[]>> {
  const result = await rows(
    untyped(db)
      .from("deletion_certificates")
      .select(CERTIFICATE_COLUMNS)
      .not("purged_at", "is", null)
      .order("purged_at", { ascending: false })
      .limit(50),
  );
  if (!result.ok) return result;
  return ok(result.data.map(toCertificate));
}

/** The certificate PDF of one of the signed-in person's certificates, or not-found. */
export async function downloadDeletionCertificate(
  db: XosClient,
  certificateId: string,
): Promise<Result<{ certificate: DeletionCertificate; bytes: Uint8Array }>> {
  const result = await rows(
    untyped(db)
      .from("deletion_certificates")
      .select(CERTIFICATE_COLUMNS)
      .eq("id", certificateId)
      .limit(1),
  );
  if (!result.ok) return result;
  const row = result.data[0];
  if (!row) return fail({ kind: "not-found" });
  const certificate = toCertificate(row);
  if (!certificate.documentObject) return fail({ kind: "not-found" });
  const { data, error } = await db.storage
    .from(DELETION_CERTIFICATES_BUCKET)
    .download(certificate.documentObject);
  if (error || !data) return fail({ kind: "not-found" });
  return ok({ certificate, bytes: new Uint8Array(await data.arrayBuffer()) });
}

// Ownership transfer --------------------------------------------------------------------------------------------------

export type TransferOutcome = "admin" | "leave";
export type TransferStatus = "open" | "accepted" | "declined" | "canceled" | "expired";

export interface OwnershipTransfer {
  readonly id: string;
  readonly orgId: string;
  readonly fromPersonId: string;
  readonly toPersonId: string;
  readonly previousOwnerOutcome: TransferOutcome;
  readonly offeredAt: string;
  readonly expiresAt: string;
  readonly status: TransferStatus;
}

export function transferStatus(r: Raw, now: Date = new Date()): TransferStatus {
  if (r["accepted_at"]) return "accepted";
  if (r["declined_at"]) return "declined";
  if (r["canceled_at"]) return "canceled";
  if (r["expired_at"] || new Date(str(r["expires_at"])).getTime() <= now.getTime())
    return "expired";
  return "open";
}

function toTransfer(r: Raw): OwnershipTransfer {
  return {
    id: str(r["id"]),
    orgId: str(r["org_id"]),
    fromPersonId: str(r["from_person_id"]),
    toPersonId: str(r["to_person_id"]),
    previousOwnerOutcome: str(r["previous_owner_outcome"]) === "leave" ? "leave" : "admin",
    offeredAt: str(r["offered_at"]),
    expiresAt: str(r["expires_at"]),
    status: transferStatus(r),
  };
}

/** The org's open ownership offer the caller may read (the Owners, the member offered it), or null. */
export async function getOpenOwnershipTransfer(
  db: XosClient,
  orgId: string,
): Promise<Result<OwnershipTransfer | null>> {
  const result = await rows(
    untyped(db)
      .from("ownership_transfers")
      .select(
        "id, org_id, from_person_id, to_person_id, previous_owner_outcome, offered_at, expires_at, accepted_at, declined_at, canceled_at, expired_at",
      )
      .eq("org_id", orgId)
      .is("accepted_at", null)
      .is("declined_at", null)
      .is("canceled_at", null)
      .is("expired_at", null)
      .is("deleted_at", null)
      .gt("expires_at", new Date().toISOString())
      .limit(1),
  );
  if (!result.ok) return result;
  const r = result.data[0];
  return ok(r ? toTransfer(r) : null);
}

export function offerOwnershipTransfer(
  db: XosClient,
  input: { orgId: string; toPersonId: string; outcome: TransferOutcome },
): Promise<Result<string>> {
  return rpc(
    db,
    "offer_ownership_transfer",
    {
      p_org_id: input.orgId,
      p_to_person_id: input.toPersonId,
      p_previous_owner_outcome: input.outcome,
    },
    str,
  );
}

export function acceptOwnershipTransfer(
  db: XosClient,
  transferId: string,
): Promise<Result<string>> {
  return rpc(db, "accept_ownership_transfer", { p_transfer_id: transferId }, str);
}

export function declineOwnershipTransfer(
  db: XosClient,
  transferId: string,
): Promise<Result<string>> {
  return rpc(db, "decline_ownership_transfer", { p_transfer_id: transferId }, str);
}

export function cancelOwnershipTransfer(
  db: XosClient,
  transferId: string,
): Promise<Result<string>> {
  return rpc(db, "cancel_ownership_transfer", { p_transfer_id: transferId }, str);
}

// Partners ------------------------------------------------------------------------------------------------------------------

export interface StandingGrant {
  readonly id: string;
  readonly capabilityCode: string;
  readonly agreementReference: string;
  readonly validFrom: string;
  readonly validTo: string;
  readonly endedAt: string | null;
  readonly open: boolean;
}

/** Standing partner grants of a client org (app.partner_standing_grants, 1354), newest first. */
export async function listStandingGrants(
  db: XosClient,
  orgId: string,
  now: Date = new Date(),
): Promise<Result<StandingGrant[]>> {
  const result = await rows(
    untyped(db)
      .from("partner_standing_grants")
      .select("id, capability_code, agreement_reference, valid_from, valid_to, ended_at")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .order("valid_from", { ascending: false })
      .limit(50),
  );
  if (!result.ok) return result;
  return ok(
    result.data.map((r) => ({
      id: str(r["id"]),
      capabilityCode: str(r["capability_code"]),
      agreementReference: str(r["agreement_reference"]),
      validFrom: str(r["valid_from"]),
      validTo: str(r["valid_to"]),
      endedAt: strOrNull(r["ended_at"]),
      open: !r["ended_at"] && new Date(str(r["valid_to"])).getTime() > now.getTime(),
    })),
  );
}

export function recordStandingGrant(
  db: XosClient,
  input: { orgId: string; capabilityCode: string; validTo: string; agreementReference: string },
): Promise<Result<string>> {
  return rpc(
    db,
    "record_standing_grant",
    {
      p_org_id: input.orgId,
      p_capability_code: input.capabilityCode,
      p_valid_to: input.validTo,
      p_agreement_reference: input.agreementReference,
    },
    str,
  );
}

export function endStandingGrant(db: XosClient, grantId: string): Promise<Result<string>> {
  return rpc(db, "end_standing_grant", { p_standing_grant_id: grantId }, str);
}

/** The client Owner moves the org off its partner (app.leave_partner). */
export function leavePartner(
  db: XosClient,
  input: { orgId: string; confirmName: string },
): Promise<Result<string>> {
  return rpc(
    db,
    "leave_partner",
    { p_org_id: input.orgId, p_confirm_name: input.confirmName },
    str,
  );
}

// Custom domains ---------------------------------------------------------------------------------------------------------

export type ProvisioningStatus =
  "Not Started" | "Requested" | "Pending DNS" | "Active" | "Failed" | "Released";

export interface DnsRecord {
  readonly type: string;
  readonly name: string;
  readonly value: string;
  readonly purpose: string | null;
}

export interface DomainProvisioning {
  readonly id: string;
  readonly hostname: string;
  readonly purpose: "Atlas" | "Gateway" | "Email Sending";
  readonly verificationState: string;
  readonly provisioningStatus: ProvisioningStatus;
  readonly dnsRecords: readonly DnsRecord[];
  readonly tlsReady: boolean;
  readonly provisioningError: string | null;
}

export function toDnsRecords(value: unknown): DnsRecord[] {
  return list(value)
    .map((r) => ({
      type: str(r["type"]),
      name: str(r["name"]),
      value: str(r["value"]),
      purpose: strOrNull(r["purpose"]),
    }))
    .filter((r) => r.type.length > 0 && r.name.length > 0);
}

/** The org's custom Atlas, Gateway and sending domains with where each stands at its provider (1355). */
export async function listDomainProvisioning(
  db: XosClient,
  orgId: string,
): Promise<Result<DomainProvisioning[]>> {
  const result = await rows(
    untyped(db)
      .from("org_domains")
      .select(
        "id, hostname, purpose, verification_state, provisioning_status, dns_records, tls_ready, provisioning_error",
      )
      .eq("org_id", orgId)
      .in("purpose", ["Atlas", "Gateway", "Email Sending"])
      .is("deleted_at", null)
      .order("hostname"),
  );
  if (!result.ok) return result;
  return ok(
    result.data.map((r) => ({
      id: str(r["id"]),
      hostname: str(r["hostname"]),
      purpose: str(r["purpose"]) as DomainProvisioning["purpose"],
      verificationState: str(r["verification_state"]),
      provisioningStatus: str(r["provisioning_status"]) as ProvisioningStatus,
      dnsRecords: toDnsRecords(r["dns_records"]),
      tlsReady: bool(r["tls_ready"]),
      provisioningError: strOrNull(r["provisioning_error"]),
    })),
  );
}

/** Asks the worker to provision a domain again or check it now (app.request_domain_check). */
export async function requestDomainCheck(db: XosClient, domainId: string): Promise<Result<string>> {
  const { data, error } = await untyped(db).rpc("request_domain_check", {
    p_org_domain_id: domainId,
  });
  if (error) return fail(toDataError(error));
  return ok(str(data));
}
