import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type DatabaseErrorLike, type Result } from "./result.ts";

/**
 * Client quotes (G-188 phase 1, ADR 0152): a quote of one budget with numbered versions. A Draft reads
 * live prices; sending freezes a Quote budget version, a content fingerprint and the Quote engagement
 * document the client signs. Acceptance is that signature and locks the quote. XOS never holds funds:
 * there is no Paid state. Every state change goes through the RPCs in 3023, and the database decides.
 */

export type QuoteVersionState = "Draft" | "Sent" | "Accepted" | "Declined" | "Withdrawn" | "Superseded";
/** A version's state as shown: Expired is computed for a Sent version past valid until. */
export type QuoteDisplayState = QuoteVersionState | "Expired";

export const QUOTE_DISPLAY_STATES: readonly QuoteDisplayState[] = [
  "Draft",
  "Sent",
  "Expired",
  "Accepted",
  "Declined",
  "Withdrawn",
  "Superseded",
];

export interface QuoteStatus {
  readonly id: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly budgetId: string;
  readonly engagementId: string | null;
  readonly key: string;
  readonly title: string;
  readonly clientName: string | null;
  readonly currentVersionId: string;
  readonly currentVersionNumber: number;
  readonly displayState: QuoteDisplayState;
  readonly validUntil: string;
  readonly sentAt: string | null;
  readonly acceptedAt: string | null;
  readonly currency: string;
  readonly clientTotalMinor: number | null;
  readonly marginMinor: number | null;
  readonly hasDraft: boolean;
}

export interface QuoteVersion {
  readonly id: string;
  readonly quoteId: string;
  readonly versionNumber: number;
  readonly state: QuoteVersionState;
  readonly validUntil: string;
  readonly terms: string | null;
  readonly budgetVersionId: string | null;
  readonly contentSha256: string | null;
  readonly engagementDocumentId: string | null;
  readonly sentAt: string | null;
  readonly sentBy: string | null;
  readonly acceptedAt: string | null;
  readonly acceptedBy: string | null;
  readonly acceptedName: string | null;
  readonly sentTitle: string | null;
  readonly sentClientName: string | null;
  readonly updatedAt: string;
}

export interface QuoteLine {
  readonly id: string;
  readonly lineNumber: number;
  readonly description: string;
  readonly quantity: number;
  readonly unitBasis: string | null;
  readonly clientUnitPriceMinor: number | null;
  readonly clientAmountMinor: number | null;
  /** Internal, never printed: cost and margin of the line. */
  readonly costAmountMinor: number | null;
  readonly marginMinor: number | null;
}

export interface QuoteDetail {
  readonly status: QuoteStatus;
  readonly versions: readonly QuoteVersion[];
  /** Client lines of the current version: live for a Draft, the capture once sent. */
  readonly lines: readonly QuoteLine[];
  readonly costTotalMinor: number | null;
}

type Raw = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : typeof v === "number" ? v : Number(v);

/** Quantity times unit price, rounded half away from zero, as private.extended_minor rounds. */
function amount(quantity: number, unit: number | null): number | null {
  if (unit === null) return null;
  const raw = quantity * unit;
  return Math.sign(raw) * Math.round(Math.abs(raw));
}

async function rows<T>(
  query: PromiseLike<{ data: unknown; error: DatabaseErrorLike | null }>,
  map: (row: Raw) => T,
): Promise<Result<T[]>> {
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok(((data as Raw[] | null) ?? []).map(map));
}

const STATUS_COLUMNS =
  "quote_id, org_id, project_id, budget_id, engagement_id, quote_key, title, client_name, current_version_id, current_version_number, display_state, valid_until, sent_at, accepted_at, currency_code, client_total_minor, margin_minor, has_draft";

const toStatus = (r: Raw): QuoteStatus => ({
  id: str(r["quote_id"]),
  orgId: str(r["org_id"]),
  projectId: str(r["project_id"]),
  budgetId: str(r["budget_id"]),
  engagementId: strOrNull(r["engagement_id"]),
  key: str(r["quote_key"]),
  title: str(r["title"]),
  clientName: strOrNull(r["client_name"]),
  currentVersionId: str(r["current_version_id"]),
  currentVersionNumber: num(r["current_version_number"]),
  displayState: str(r["display_state"]) as QuoteDisplayState,
  validUntil: str(r["valid_until"]),
  sentAt: strOrNull(r["sent_at"]),
  acceptedAt: strOrNull(r["accepted_at"]),
  currency: str(r["currency_code"]),
  clientTotalMinor: numOrNull(r["client_total_minor"]),
  marginMinor: numOrNull(r["margin_minor"]),
  hasDraft: r["has_draft"] === true,
});

const toVersion = (r: Raw): QuoteVersion => ({
  id: str(r["id"]),
  quoteId: str(r["quote_id"]),
  versionNumber: num(r["version_number"]),
  state: str(r["quote_version_state"]) as QuoteVersionState,
  validUntil: str(r["valid_until"]),
  terms: strOrNull(r["terms"]),
  budgetVersionId: strOrNull(r["budget_version_id"]),
  contentSha256: strOrNull(r["content_sha256"]),
  engagementDocumentId: strOrNull(r["engagement_document_id"]),
  sentAt: strOrNull(r["sent_at"]),
  sentBy: strOrNull(r["sent_by"]),
  acceptedAt: strOrNull(r["accepted_at"]),
  acceptedBy: strOrNull(r["accepted_by"]),
  acceptedName: strOrNull(r["accepted_name"]),
  sentTitle: strOrNull(r["sent_title"]),
  sentClientName: strOrNull(r["sent_client_name"]),
  updatedAt: str(r["updated_at"]),
});

/** Every live quote of an org the viewer can read, newest first, optionally of one project. */
export async function listQuotes(
  db: XosClient,
  filter: { readonly orgId: string; readonly projectId?: string | null },
): Promise<Result<QuoteStatus[]>> {
  let query = db.from("quote_statuses").select(STATUS_COLUMNS).eq("org_id", filter.orgId);
  if (filter.projectId) query = query.eq("project_id", filter.projectId);
  return rows(query.order("quote_id", { ascending: false }), toStatus);
}

/** How many live quotes a project has, for the budget page's "Quotes (n)" link. */
export async function countProjectQuotes(db: XosClient, projectId: string): Promise<Result<number>> {
  const { count, error } = await db
    .from("quote_statuses")
    .select("quote_id", { count: "exact", head: true })
    .eq("project_id", projectId);
  if (error) return fail(toDataError(error));
  return ok(count ?? 0);
}

/** A quote with its versions and the client lines of its current version. */
export async function getQuote(db: XosClient, quoteId: string): Promise<Result<QuoteDetail>> {
  const [status, versions] = await Promise.all([
    rows(db.from("quote_statuses").select(STATUS_COLUMNS).eq("quote_id", quoteId), toStatus),
    rows(
      db
        .from("quote_versions")
        .select(
          "id, quote_id, version_number, quote_version_state, valid_until, terms, budget_version_id, content_sha256, engagement_document_id, sent_at, sent_by, accepted_at, accepted_by, accepted_name, sent_title, sent_client_name, updated_at",
        )
        .eq("quote_id", quoteId)
        .is("deleted_at", null)
        .order("version_number", { ascending: false }),
      toVersion,
    ),
  ]);
  if (!status.ok) return status;
  if (!versions.ok) return versions;
  const head = status.data[0];
  if (!head) return fail({ kind: "not-found" });
  const current = versions.data.find((v) => v.id === head.currentVersionId);
  const lines = current?.budgetVersionId
    ? await capturedLines(db, current.budgetVersionId)
    : await liveLines(db, head.budgetId);
  if (!lines.ok) return lines;
  let costTotal: number | null = 0;
  for (const line of lines.data) {
    costTotal = costTotal === null || line.costAmountMinor === null ? null : costTotal + line.costAmountMinor;
  }
  return ok({ status: head, versions: versions.data, lines: lines.data, costTotalMinor: costTotal });
}

async function capturedLines(db: XosClient, budgetVersionId: string): Promise<Result<QuoteLine[]>> {
  return rows(
    db
      .from("budget_version_lines")
      .select(
        "id, budget_version_id, line_number, description, quantity, unit_basis, unit_price_minor, client_unit_price_minor, excluded_from_quote",
      )
      .eq("budget_version_id", budgetVersionId)
      .eq("excluded_from_quote", false)
      .order("line_number"),
    (r): QuoteLine => {
      const quantity = num(r["quantity"]);
      const client = numOrNull(r["client_unit_price_minor"]);
      const clientAmount = amount(quantity, client);
      const cost = amount(quantity, numOrNull(r["unit_price_minor"]));
      return {
        id: str(r["id"]),
        lineNumber: num(r["line_number"]),
        description: str(r["description"]),
        quantity,
        unitBasis: strOrNull(r["unit_basis"]),
        clientUnitPriceMinor: client,
        clientAmountMinor: clientAmount,
        costAmountMinor: cost,
        marginMinor: clientAmount === null || cost === null ? null : clientAmount - cost,
      };
    },
  );
}

async function liveLines(db: XosClient, budgetId: string): Promise<Result<QuoteLine[]>> {
  const [lines, prices] = await Promise.all([
    rows(
      db
        .from("budget_lines")
        .select("id, line_number, description, quantity, unit_basis")
        .eq("budget_id", budgetId)
        .eq("excluded_from_quote", false)
        .is("deleted_at", null)
        .order("line_number"),
      (r) => r,
    ),
    rows(db.from("budget_line_prices").select("*").eq("budget_id", budgetId), (r) => r),
  ]);
  if (!lines.ok) return lines;
  if (!prices.ok) return prices;
  const priceBy = new Map(prices.data.map((p) => [str(p["budget_line_id"]), p]));
  return ok(
    lines.data.map((r): QuoteLine => {
      const price = priceBy.get(str(r["id"]));
      return {
        id: str(r["id"]),
        lineNumber: num(r["line_number"]),
        description: str(r["description"]),
        quantity: num(r["quantity"]),
        unitBasis: strOrNull(r["unit_basis"]),
        clientUnitPriceMinor: numOrNull(price?.["client_unit_price_minor"]),
        clientAmountMinor: numOrNull(price?.["client_extended_minor"]),
        costAmountMinor: numOrNull(price?.["cost_extended_minor"]),
        marginMinor: numOrNull(price?.["margin_minor"]),
      };
    }),
  );
}

// Writes ----------------------------------------------------------------------------------------------

export async function createQuote(
  db: XosClient,
  input: {
    readonly budgetId: string;
    readonly title: string;
    readonly engagementId: string | null;
    readonly validUntil: string | null;
    readonly terms?: string | null;
  },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db.rpc("create_quote", {
    p_budget_id: input.budgetId,
    p_title: input.title.trim(),
    p_engagement_id: input.engagementId as string,
    p_valid_until: input.validUntil as string,
    p_terms: (input.terms ?? null) as string,
  });
  if (error) return fail(toDataError(error));
  return ok({ id: data });
}

export async function createQuoteVersion(
  db: XosClient,
  quoteId: string,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db.rpc("create_quote_version", { p_quote_id: quoteId });
  if (error) return fail(toDataError(error));
  return ok({ id: data });
}

/** Edits a Draft's valid until and terms; the guard refuses anything else. */
export async function updateQuoteDraft(
  db: XosClient,
  versionId: string,
  input: { readonly validUntil: string; readonly terms: string | null },
): Promise<Result<null>> {
  const { error } = await db
    .from("quote_versions")
    .update({ valid_until: input.validUntil, terms: input.terms })
    .eq("id", versionId);
  return error ? fail(toDataError(error)) : ok(null);
}

export async function updateQuote(
  db: XosClient,
  quoteId: string,
  input: { readonly title: string; readonly engagementId: string | null },
): Promise<Result<null>> {
  const { error } = await db
    .from("quotes")
    .update({ title: input.title.trim(), engagement_id: input.engagementId })
    .eq("id", quoteId);
  return error ? fail(toDataError(error)) : ok(null);
}

export async function deleteQuoteDraft(db: XosClient, versionId: string): Promise<Result<null>> {
  const { error } = await db
    .from("quote_versions")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", versionId);
  return error ? fail(toDataError(error)) : ok(null);
}

export async function restoreQuoteDraft(db: XosClient, versionId: string): Promise<Result<null>> {
  const { error } = await db.from("quote_versions").update({ deleted_at: null }).eq("id", versionId);
  return error ? fail(toDataError(error)) : ok(null);
}

/** A quote soft-deleted with its only Draft comes back through the quote. */
export async function restoreQuote(db: XosClient, quoteId: string): Promise<Result<null>> {
  const { error } = await db.from("quotes").update({ deleted_at: null }).eq("id", quoteId);
  return error ? fail(toDataError(error)) : ok(null);
}

export async function sendQuoteVersion(
  db: XosClient,
  versionId: string,
  reason: string | null,
): Promise<Result<{ engagementDocumentId: string; contentSha256: string }>> {
  const { data, error } = await db.rpc("send_quote_version", {
    p_quote_version_id: versionId,
    p_reason: (reason ?? null) as string,
  });
  if (error) return fail(toDataError(error));
  const row = (data as { engagement_document_id: string; content_sha256: string }[] | null)?.[0];
  if (!row) return fail({ kind: "unexpected", message: "The sent quote was not returned." });
  return ok({ engagementDocumentId: row.engagement_document_id, contentSha256: row.content_sha256 });
}

export async function withdrawQuoteVersion(
  db: XosClient,
  versionId: string,
  reason: string | null,
): Promise<Result<null>> {
  const { error } = await db.rpc("withdraw_quote_version", {
    p_quote_version_id: versionId,
    p_reason: (reason ?? null) as string,
  });
  return error ? fail(toDataError(error)) : ok(null);
}

export async function declineQuoteVersion(
  db: XosClient,
  versionId: string,
  reason: string | null,
): Promise<Result<null>> {
  const { error } = await db.rpc("decline_quote_version", {
    p_quote_version_id: versionId,
    p_reason: (reason ?? null) as string,
  });
  return error ? fail(toDataError(error)) : ok(null);
}

/** The email a signing link went to (app.quote_acceptance), or null when signed in to Gateway. */
export async function quoteAcceptanceEmail(
  db: XosClient,
  versionId: string,
): Promise<Result<string | null>> {
  const { data, error } = await db.rpc("quote_acceptance", { p_quote_version_id: versionId });
  if (error) return fail(toDataError(error));
  return ok((data as { accepted_email: string }[] | null)?.[0]?.accepted_email ?? null);
}

export interface QuoteEngagementOption {
  readonly id: string;
  readonly projectId: string;
  readonly label: string;
  readonly email: string | null;
}

/** Hours of link validity left: never past the end of valid until in the project's zone, at most 14 days. */
export function signingLinkHours(
  validUntil: string,
  timeZone: string,
  now: Date = new Date(),
): number {
  // The instant the last day ends in the zone: find the zone's offset at the end of that day.
  const naive = new Date(`${validUntil}T23:59:59Z`);
  const shown = new Date(naive.toLocaleString("en-US", { timeZone: "UTC" }));
  const zoned = new Date(naive.toLocaleString("en-US", { timeZone }));
  const end = new Date(naive.getTime() + (shown.getTime() - zoned.getTime()));
  const hours = Math.floor((end.getTime() - now.getTime()) / 3_600_000);
  return Math.min(hours, 14 * 24);
}
