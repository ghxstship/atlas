import type { XosClient } from "./client.ts";
import type { Json } from "./database.types.ts";
import { external, type ExternalRow, type ExternalView } from "./gateway-external.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Gateway operations (A28b migrations 0760 to 0775, Section 8.7 areas): the party's own rows that
 * fill the engagement tabs and Money, and the RPCs the party calls. Reads are generic over the
 * `api_external` views, filtered by the engagement, project or account a page shows; every view
 * already limits rows to what the caller may see, so the filters only narrow.
 */

export interface ViewFilter {
  /** Equality filters, column to value. */
  readonly eq?: Readonly<Record<string, string | boolean>>;
  /** One membership filter: column and allowed values. An empty list reads nothing. */
  readonly in?: readonly [string, readonly string[]];
  /** Order column and direction. */
  readonly order?: readonly [string, "asc" | "desc"];
  readonly limit?: number;
}

/** Rows of one `api_external` view the caller may see, narrowed by the filter. */
export async function readView<V extends ExternalView>(
  db: XosClient,
  view: V,
  filter: ViewFilter = {},
): Promise<Result<ExternalRow<V>[]>> {
  if (filter.in && filter.in[1].length === 0) return ok([]);
  type Query = PromiseLike<{
    data: unknown[] | null;
    error: { code?: string; message: string } | null;
  }> & {
    eq(column: string, value: unknown): Query;
    in(column: string, values: readonly unknown[]): Query;
    order(column: string, options: { ascending: boolean; nullsFirst?: boolean }): Query;
    limit(count: number): Query;
  };
  let query = (external(db).from(view) as unknown as { select(columns: string): Query }).select(
    "*",
  );
  for (const [column, value] of Object.entries(filter.eq ?? {})) query = query.eq(column, value);
  if (filter.in) query = query.in(filter.in[0], filter.in[1]);
  if (filter.order)
    query = query.order(filter.order[0], {
      ascending: filter.order[1] === "asc",
      nullsFirst: false,
    });
  if (filter.limit) query = query.limit(filter.limit);
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok((data ?? []) as ExternalRow<V>[]);
}

async function call(
  promise: PromiseLike<{ error: { code?: string; message: string } | null }>,
): Promise<Result<null>> {
  const { error } = await promise;
  return error ? fail(toDataError(error)) : ok(null);
}

async function callId(
  promise: PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>,
): Promise<Result<{ id: string }>> {
  const { data, error } = await promise;
  if (error) return fail(toDataError(error));
  return ok({ id: String(data) });
}

// Offers ----------------------------------------------------------------------------------------

/** The party accepts the offer in force (app.accept_offer). */
export function acceptOffer(db: XosClient, offerId: string): Promise<Result<null>> {
  return call(db.rpc("accept_offer", { p_offer_id: offerId }));
}

/** The party declines an offer with a reason (app.decline_offer). */
export function declineOffer(
  db: XosClient,
  input: { offerId: string; reason: string },
): Promise<Result<null>> {
  return call(db.rpc("decline_offer", { p_offer_id: input.offerId, p_reason: input.reason }));
}

/** The party counters with new terms (app.counter_offer); returns the new version id. */
export function counterOffer(
  db: XosClient,
  input: {
    readonly offerId: string;
    readonly amountMinor: number;
    readonly currency: string;
    readonly rateType: ExternalRow<"offer_versions">["rate_type"] & string;
    readonly startsOn: string;
    readonly endsOn: string;
    readonly message: string;
  },
): Promise<Result<{ id: string }>> {
  return callId(
    db.rpc("counter_offer", {
      p_offer_id: input.offerId,
      p_amount_minor: input.amountMinor,
      p_currency_code: input.currency,
      p_rate_type: input.rateType,
      p_starts_on: input.startsOn,
      p_ends_on: input.endsOn,
      p_message: input.message,
    }),
  );
}

// Onboarding uploads ----------------------------------------------------------------------------

/** The object name an onboarding upload takes in the onboarding-uploads bucket (0762). */
export function onboardingObjectName(input: {
  readonly orgId: string;
  readonly engagementId: string;
  readonly itemId: string;
  readonly fileName: string;
}): string {
  const safe = input.fileName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "upload";
  return `${input.orgId}/${input.engagementId}/${input.itemId}/${Date.now().toString(36)}-${safe}`;
}

/**
 * Uploads a file for an onboarding item and registers it (app.register_onboarding_upload), which
 * makes it a document of the org and submits the item in one transaction.
 */
export async function uploadOnboardingFile(
  db: XosClient,
  input: {
    readonly objectName: string;
    readonly title: string;
    readonly body: Blob;
    readonly contentType: string;
    readonly checksumSha256: string;
  },
): Promise<Result<{ documentId: string }>> {
  const uploaded = await db.storage
    .from("onboarding-uploads")
    .upload(input.objectName, input.body, { contentType: input.contentType, upsert: false });
  if (uploaded.error) return fail({ kind: "unexpected", message: uploaded.error.message });
  const { data, error } = await db.rpc("register_onboarding_upload", {
    p_object_name: input.objectName,
    p_title: input.title,
    p_checksum_sha256: input.checksumSha256,
  });
  if (error) return fail(toDataError(error));
  return ok({ documentId: data });
}

// Money -------------------------------------------------------------------------------------------

export interface InvoiceLineInput {
  readonly description: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
}

/** The party submits an invoice against an engagement (app.submit_engagement_invoice). */
export function submitEngagementInvoice(
  db: XosClient,
  input: {
    readonly engagementId: string;
    readonly invoiceNumber: string;
    readonly issuedOn: string;
    readonly dueOn: string;
    readonly currency: string;
    readonly lines: readonly InvoiceLineInput[];
  },
): Promise<Result<{ id: string }>> {
  return callId(
    db.rpc("submit_engagement_invoice", {
      p_engagement_id: input.engagementId,
      p_invoice_number: input.invoiceNumber,
      p_issued_on: input.issuedOn,
      p_due_on: input.dueOn,
      p_currency_code: input.currency,
      p_lines: input.lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unit_price_minor: l.unitPriceMinor,
      })) as unknown as Json,
    }),
  );
}

/** The party agrees to self-billing from approved timesheets (app.agree_self_billing). */
export function agreeSelfBilling(
  db: XosClient,
  engagementId: string,
): Promise<Result<{ id: string }>> {
  return callId(db.rpc("agree_self_billing", { p_engagement_id: engagementId }));
}

/** The party withdraws its self-billing agreement (app.revoke_self_billing). */
export function revokeSelfBilling(db: XosClient, engagementId: string): Promise<Result<null>> {
  return call(db.rpc("revoke_self_billing", { p_engagement_id: engagementId }));
}

/**
 * Where an invoice stands on the payment tracker: Submitted, Approved, Scheduled, Paid. Scheduled
 * means a payment is recorded against it and awaits approval (`scheduled_minor`, 1123) or part of it
 * is paid; Paid means approved payments cover the whole total. Invoice states themselves stay
 * Proposed, Issued, Approved, Disputed and Canceled.
 */
export function invoiceTrackerStep(row: {
  readonly invoice_state: string | null;
  readonly approved_at: string | null;
  readonly balance_minor: number | null;
  readonly applied_minor: number | null;
  readonly last_paid_on: string | null;
  readonly scheduled_minor?: number | null;
}): 0 | 1 | 2 | 3 {
  if (row.balance_minor === 0 && (row.applied_minor ?? 0) > 0) return 3;
  if ((row.applied_minor ?? 0) > 0 || row.last_paid_on !== null || (row.scheduled_minor ?? 0) > 0)
    return 2;
  if (row.invoice_state === "Approved" || row.approved_at !== null) return 1;
  return 0;
}

/** The party submits a timesheet for approval (app.submit_timesheet). */
export function submitTimesheet(
  db: XosClient,
  timesheetId: string,
): Promise<Result<{ id: string }>> {
  return callId(
    db.rpc("submit_timesheet", {
      p_timesheet_id: timesheetId,
      p_reason: "Submitted from Gateway.",
    }),
  );
}

/** Worked minutes as hours to two decimals; null stays null (Section 3.7). */
export function hoursFromMinutes(minutes: number | null): number | null {
  return minutes === null ? null : Math.round((minutes / 60) * 100) / 100;
}

// Crew and staff ------------------------------------------------------------------------------------

/** An engaged crew member accepts a published shift (app.accept_engaged_shift). */
export function acceptEngagedShift(
  db: XosClient,
  shiftId: string,
): Promise<Result<{ id: string }>> {
  return callId(
    db.rpc("accept_engaged_shift", { p_shift_id: shiftId, p_reason: "Accepted from Gateway." }),
  );
}

// Staffing agencies (R12) ------------------------------------------------------------------------------
// The agency's lead places its roster staff on the slots the production allocated (Positions), and the person on a
// roster entry acknowledges the training due on it before their first shift (api_external.my_roster_training).

export { assignRosterShift, rosterTrainingSummary, unassignRosterShift } from "./crew/agency.ts";

/** The person on a roster entry acknowledges training due on it (app.acknowledge_roster_training). */
export function acknowledgeRosterTraining(
  db: XosClient,
  input: { readonly rosterEntryId: string; readonly requirementId: string },
): Promise<Result<{ id: string }>> {
  return callId(
    db.rpc("acknowledge_roster_training", {
      p_roster_entry_id: input.rosterEntryId,
      p_requirement_id: input.requirementId,
    }),
  );
}

// Vendor -------------------------------------------------------------------------------------------

/** The vendor acknowledges a sent purchase order (app.acknowledge_purchase_order). */
export function acknowledgePurchaseOrder(
  db: XosClient,
  purchaseOrderId: string,
): Promise<Result<{ id: string }>> {
  return callId(db.rpc("acknowledge_purchase_order", { p_purchase_order_id: purchaseOrderId }));
}

/**
 * The vendor submits a Proposed submittal or resubmits a Returned one with a note
 * (app.submit_engaged_submittal, R2); returns the transition id.
 */
export function submitEngagedSubmittal(
  db: XosClient,
  input: {
    readonly submittalId: string;
    readonly expected: "Proposed" | "Returned";
    readonly note: string;
  },
): Promise<Result<{ id: string }>> {
  return callId(
    db.rpc("submit_engaged_submittal", {
      p_submittal_id: input.submittalId,
      p_expected: input.expected,
      p_note: input.note,
    }),
  );
}

// Artist and advancing -------------------------------------------------------------------------------

/** The engaged party answers an advance section (app.submit_engaged_advance_answer). */
export function submitAdvanceAnswer(
  db: XosClient,
  input: { readonly recipientId: string; readonly sectionId: string; readonly body: string },
): Promise<Result<{ id: string }>> {
  return callId(
    db.rpc("submit_engaged_advance_answer", {
      p_recipient_id: input.recipientId,
      p_section_id: input.sectionId,
      p_body: input.body,
    }),
  );
}

// Client ---------------------------------------------------------------------------------------------

/** The client approves or rejects a requested approval (app.decide_client_approval). */
export function decideClientApproval(
  db: XosClient,
  input: {
    readonly requestId: string;
    readonly decision: "Approved" | "Rejected";
    readonly response: string;
  },
): Promise<Result<null>> {
  return call(
    db.rpc("decide_client_approval", {
      p_request_id: input.requestId,
      p_decision: input.decision,
      p_response: input.response,
    }),
  );
}

// Contractor -------------------------------------------------------------------------------------------

/** The contractor submits a deliverable with its document (app.submit_deliverable). */
export function submitDeliverable(
  db: XosClient,
  input: { readonly deliverableId: string; readonly documentId: string; readonly message: string },
): Promise<Result<{ id: string }>> {
  return callId(
    db.rpc("submit_deliverable", {
      p_deliverable_id: input.deliverableId,
      p_document_id: input.documentId,
      p_message: input.message,
    }),
  );
}

// Token claims ------------------------------------------------------------------------------------------

/** Links token submissions sent to the caller's verified email to their account (Section 4.4.6). */
export async function claimTokenSubmissions(
  db: XosClient,
): Promise<Result<{ advance: number; documents: number }>> {
  const { data, error } = await db.rpc("claim_token_submissions");
  if (error) return fail(toDataError(error));
  const row = data[0];
  return ok({ advance: row?.claimed_advance ?? 0, documents: row?.claimed_documents ?? 0 });
}
