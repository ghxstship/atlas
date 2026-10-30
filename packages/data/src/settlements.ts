import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type DatabaseErrorLike, type Result } from "./result.ts";
import { untyped } from "./untyped.ts";
import type { Database } from "./database.types.ts";
import * as enums from "./enums.generated.ts";

/**
 * Settlements and self-billing repository (A15, migrations 0991 and 0992). A settlement settles one
 * engagement: the org drafts lines, submits under Contract spend authority, the party accepts or
 * disputes in Gateway, and the org marks it paid. Self-billing generates a payable invoice from the
 * engagement's approved timesheets when the org enables it and the party agrees (Section 4.4.5).
 * Money is minor units; a blank amount is unpriced and the net stays NULL (Section 3.7).
 */

export type SettlementState = Database["app"]["Enums"]["settlement_state"];
export type SettlementLineKind = Database["app"]["Enums"]["settlement_line_kind"];

export const SETTLEMENT_STATES: readonly SettlementState[] = enums.settlementState;
export const SETTLEMENT_LINE_KINDS: readonly SettlementLineKind[] = enums.settlementLineKind;

/** Org-side moves of a settlement; Accepted and Disputed belong to the party. */
export const SETTLEMENT_ORG_NEXT: Readonly<Record<SettlementState, readonly SettlementState[]>> = {
  Proposed: ["Submitted", "Canceled"],
  Submitted: ["Proposed", "Canceled"],
  Disputed: ["Proposed", "Canceled"],
  Accepted: ["Paid"],
  Paid: [],
  Canceled: [],
};

type Raw = Record<string, unknown>;
type Query = PromiseLike<{ data: unknown; error: DatabaseErrorLike | null }>;

const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : typeof v === "number" ? v : Number(v);
const obj = (v: unknown): Raw | null =>
  Array.isArray(v) ? ((v[0] as Raw | undefined) ?? null) : ((v as Raw | null) ?? null);

async function rows<T>(query: Query, map: (row: Raw) => T): Promise<Result<T[]>> {
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok(((data as Raw[] | null) ?? []).map(map));
}

async function value<T>(query: Query): Promise<Result<T>> {
  const { data, error } = await query;
  return error ? fail(toDataError(error)) : ok(data as T);
}

export interface Settlement {
  readonly id: string;
  readonly engagementId: string;
  readonly projectId: string;
  readonly number: number;
  readonly title: string;
  readonly currency: string;
  readonly settledOn: string | null;
  readonly state: SettlementState;
  readonly lineCount: number;
  readonly unpricedCount: number;
  readonly netMinor: number | null;
  readonly createdBy: string | null;
}

export interface SettlementLine {
  readonly id: string;
  readonly lineNumber: number;
  readonly kind: SettlementLineKind;
  readonly description: string;
  readonly amountMinor: number | null;
}

/** Settlements the viewer may read, newest first, with their NULL-aware net. */
export async function listSettlements(
  db: XosClient,
  input: { readonly orgId: string; readonly projectId?: string | null },
): Promise<Result<Settlement[]>> {
  let query = untyped(db)
    .from("settlements")
    .select(
      "id, engagement_id, project_id, settlement_number, title, currency_code, settled_on, settlement_state, created_by",
    )
    .eq("org_id", input.orgId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (input.projectId) query = query.eq("project_id", input.projectId);
  const settlements = await rows(query, (r) => r);
  if (!settlements.ok) return settlements;
  if (settlements.data.length === 0) return ok([]);
  const totals = await rows(
    untyped(db)
      .from("settlement_totals")
      .select("settlement_id, line_count, unpriced_count, net_minor")
      .in(
        "settlement_id",
        settlements.data.map((s) => str(s["id"])),
      ),
    (r) => r,
  );
  if (!totals.ok) return totals;
  const byId = new Map(totals.data.map((t) => [str(t["settlement_id"]), t]));
  return ok(
    settlements.data.map((s) => {
      const t = byId.get(str(s["id"])) ?? {};
      return {
        id: str(s["id"]),
        engagementId: str(s["engagement_id"]),
        projectId: str(s["project_id"]),
        number: num(s["settlement_number"]),
        title: str(s["title"]),
        currency: str(s["currency_code"]).trim(),
        settledOn: strOrNull(s["settled_on"]),
        state: str(s["settlement_state"]) as SettlementState,
        lineCount: num(t["line_count"]),
        unpricedCount: num(t["unpriced_count"]),
        netMinor: numOrNull(t["net_minor"]),
        createdBy: strOrNull(s["created_by"]),
      };
    }),
  );
}

export async function listSettlementLines(
  db: XosClient,
  settlementId: string,
): Promise<Result<SettlementLine[]>> {
  return rows(
    untyped(db)
      .from("settlement_lines")
      .select("id, line_number, line_kind, description, amount_minor")
      .eq("settlement_id", settlementId)
      .is("deleted_at", null)
      .order("line_number"),
    (r) => ({
      id: str(r["id"]),
      lineNumber: num(r["line_number"]),
      kind: str(r["line_kind"]) as SettlementLineKind,
      description: str(r["description"]),
      amountMinor: numOrNull(r["amount_minor"]),
    }),
  );
}

export interface EngagementRef {
  readonly id: string;
  readonly projectId: string;
  readonly roleType: string;
  readonly state: string;
  readonly currency: string | null;
  readonly counterpartyId: string | null;
  readonly personName: string | null;
}

/** Engagements of the org the viewer may read, for settlements and self-billing. */
export async function listEngagementRefs(
  db: XosClient,
  input: { readonly orgId: string; readonly projectId?: string | null },
): Promise<Result<EngagementRef[]>> {
  let query = untyped(db)
    .from("engagements")
    .select(
      "id, project_id, role_type, engagement_state, currency_code, counterparty_id, person:people!engagements_person_id_fkey(full_name)",
    )
    .eq("org_id", input.orgId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (input.projectId) query = query.eq("project_id", input.projectId);
  return rows(query, (r) => ({
    id: str(r["id"]),
    projectId: str(r["project_id"]),
    roleType: str(r["role_type"]),
    state: str(r["engagement_state"]),
    currency: strOrNull(r["currency_code"])?.trim() ?? null,
    counterpartyId: strOrNull(r["counterparty_id"]),
    personName: strOrNull(obj(r["person"])?.["full_name"]),
  }));
}

/** Drafts a settlement; the project and number come from the engagement and its sequence. */
export async function createSettlement(
  db: XosClient,
  orgId: string,
  input: {
    readonly engagementId: string;
    readonly title: string;
    readonly currency: string;
    readonly settledOn: string | null;
  },
): Promise<Result<{ id: string }>> {
  const { data, error } = await untyped(db)
    .from("settlements")
    .insert({
      org_id: orgId,
      engagement_id: input.engagementId,
      title: input.title.trim(),
      currency_code: input.currency,
      settled_on: input.settledOn,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: str((data as Raw)["id"]) });
}

export async function addSettlementLine(
  db: XosClient,
  orgId: string,
  settlementId: string,
  input: {
    readonly kind: SettlementLineKind;
    readonly description: string;
    readonly amountMinor: number | null;
  },
): Promise<Result<null>> {
  const last = await rows(
    untyped(db)
      .from("settlement_lines")
      .select("line_number")
      .eq("settlement_id", settlementId)
      .is("deleted_at", null)
      .order("line_number", { ascending: false })
      .limit(1),
    (r) => num(r["line_number"]),
  );
  if (!last.ok) return last;
  const { error } = await untyped(db)
    .from("settlement_lines")
    .insert({
      org_id: orgId,
      settlement_id: settlementId,
      line_number: (last.data[0] ?? 0) + 1,
      line_kind: input.kind,
      description: input.description.trim(),
      amount_minor: input.amountMinor,
    });
  return error ? fail(toDataError(error)) : ok(null);
}

export async function deleteSettlementLine(db: XosClient, lineId: string): Promise<Result<null>> {
  const { error } = await untyped(db)
    .from("settlement_lines")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", lineId);
  return error ? fail(toDataError(error)) : ok(null);
}

/**
 * Submits a priced settlement to the party under Contract spend authority; `complete` is false while
 * a second approver is still needed above the dual threshold.
 */
export async function submitSettlement(
  db: XosClient,
  id: string,
  reason: string,
): Promise<Result<{ complete: boolean }>> {
  const r = await value<boolean>(
    untyped(db).rpc("submit_settlement", { p_settlement_id: id, p_reason: reason }),
  );
  return r.ok ? ok({ complete: r.data === true }) : r;
}

export async function transitionSettlement(
  db: XosClient,
  input: {
    readonly id: string;
    readonly expected: SettlementState;
    readonly next: SettlementState;
    readonly reason: string;
  },
): Promise<Result<null>> {
  const r = await value(
    untyped(db).rpc("transition_settlement", {
      p_settlement_id: input.id,
      p_expected: input.expected,
      p_next: input.next,
      p_reason: input.reason,
    }),
  );
  return r.ok ? ok(null) : r;
}

/**
 * Generates a payable invoice from the engagement's approved timesheets in a period. The database
 * refuses unless self-billing is on and the party holds a live agreement.
 */
export async function generateSelfBilledInvoice(
  db: XosClient,
  input: {
    readonly engagementId: string;
    readonly periodStart: string;
    readonly periodEnd: string;
  },
): Promise<Result<{ id: string }>> {
  const r = await value<string>(
    untyped(db).rpc("generate_self_billed_invoice", {
      p_engagement_id: input.engagementId,
      p_period_start: input.periodStart,
      p_period_end: input.periodEnd,
    }),
  );
  return r.ok ? ok({ id: r.data }) : r;
}
