import type { XosClient } from "./client.ts";
import { callRpc, derivedOrg, writeResult } from "./places.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Requirements and capability reconciliation (Section 7.4): requirements and capabilities share one
 * shape (app.capability_statements) with a direction facet, so reconciliation is a join. The result
 * of each run is computed by app.reconcile_project in the database (migration 0420) with the silence
 * rule of Section 3.7: no claim, or an UNKNOWN claim, is Unknown and never Met. This module never
 * recomputes a result; it reads what the database decided.
 */

export type CapabilityDirection = "Require" | "Provide";
export type ReconciliationResult = "Met" | "Gap" | "Unknown";

export interface CapabilityStatement {
  readonly id: string;
  readonly projectId: string;
  readonly direction: CapabilityDirection;
  readonly urid: string;
  readonly description: string;
  /** NULL when uncounted; never coerced to zero. */
  readonly quantity: number | null;
  readonly unitBasis: string | null;
  readonly critical: boolean;
  /** Capability assertion word (Bible tab 22); silence is UNKNOWN. */
  readonly assertionWord: string;
  readonly venueId: string | null;
  readonly counterpartyId: string | null;
  /**
   * For a capability copied from venue specs by app.provide_place_specs (B1, ADR 0140 D9): which group it states.
   * Such a row is managed by that function; a person may only move it to Trash.
   */
  readonly placeSpecField: "power" | "rigging" | "connectivity" | null;
  /** Computed when read, never stored: the spec changed after the row was written. */
  readonly specsChanged: boolean;
  /** Computed when read: a DOCUMENTED row whose spec document is no longer live and unexpired. */
  readonly documentExpired: boolean;
}

export interface CapabilityStatementInput {
  readonly projectId: string;
  readonly direction: CapabilityDirection;
  readonly urid: string;
  readonly description: string;
  readonly quantity?: number | null;
  readonly unitBasis?: string | null;
  readonly critical?: boolean;
  readonly assertionWord?: string;
  readonly venueId?: string | null;
  readonly counterpartyId?: string | null;
}

const STATEMENT_COLUMNS =
  "id, project_id, direction, urid, description, quantity, unit_basis, is_critical, assertion_word, venue_id, counterparty_id, place_spec_field, updated_at, spec:place_specs!capability_statements_place_spec_id_fkey(updated_at, document:capability_documents!place_specs_spec_document_id_fkey(valid_from, valid_to, deleted_at))";

interface StatementRow {
  id: string;
  project_id: string;
  direction: CapabilityDirection;
  urid: string;
  description: string;
  quantity: number | null;
  unit_basis: string | null;
  is_critical: boolean;
  assertion_word: string;
  venue_id: string | null;
  counterparty_id: string | null;
  place_spec_field?: "power" | "rigging" | "connectivity" | null;
  updated_at?: string;
  spec?: {
    updated_at: string;
    document: { valid_from: string; valid_to: string | null; deleted_at: string | null } | null;
  } | null;
}

/** A capability document is live and unexpired on a day (YYYY-MM-DD), as provide_place_specs judges it. */
function documentLive(
  document:
    { valid_from: string; valid_to: string | null; deleted_at: string | null } | null | undefined,
  today: string,
): boolean {
  return (
    !!document &&
    document.deleted_at === null &&
    document.valid_from <= today &&
    (document.valid_to === null || document.valid_to >= today)
  );
}

function toStatement(row: StatementRow, now: Date = new Date()): CapabilityStatement {
  const spec = row.spec ?? null;
  return {
    id: row.id,
    projectId: row.project_id,
    direction: row.direction,
    urid: row.urid,
    description: row.description,
    quantity: row.quantity === null ? null : Number(row.quantity),
    unitBasis: row.unit_basis,
    critical: row.is_critical,
    assertionWord: row.assertion_word,
    venueId: row.venue_id,
    counterpartyId: row.counterparty_id,
    placeSpecField: row.place_spec_field ?? null,
    specsChanged:
      spec !== null &&
      row.updated_at !== undefined &&
      Date.parse(spec.updated_at) > Date.parse(row.updated_at),
    documentExpired:
      spec !== null &&
      row.assertion_word === "DOCUMENTED" &&
      !documentLive(spec.document, now.toISOString().slice(0, 10)),
  };
}

/** Live statements of a project, or every project's statements a venue provides, in URID order. */
export async function listCapabilityStatements(
  db: XosClient,
  filter: { readonly projectId?: string; readonly venueId?: string },
): Promise<Result<CapabilityStatement[]>> {
  let query = db.from("capability_statements").select(STATEMENT_COLUMNS).is("deleted_at", null);
  if (filter.projectId) query = query.eq("project_id", filter.projectId);
  if (filter.venueId) query = query.eq("venue_id", filter.venueId);
  const { data, error } = await query.order("urid").order("direction");
  if (error) return fail(toDataError(error));
  return ok((data as unknown as StatementRow[]).map((r) => toStatement(r)));
}

export async function createCapabilityStatement(
  db: XosClient,
  input: CapabilityStatementInput,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("capability_statements")
    .insert(
      derivedOrg<"capability_statements">({
        project_id: input.projectId,
        direction: input.direction,
        urid: input.urid,
        description: input.description.trim(),
        quantity: input.quantity ?? null,
        unit_basis: input.unitBasis ?? null,
        is_critical: input.direction === "Require" ? (input.critical ?? false) : false,
        assertion_word: input.assertionWord ?? "UNKNOWN",
        venue_id: input.venueId ?? null,
        counterparty_id: input.counterpartyId ?? null,
      }),
    )
    .select("id");
  return writeResult(data, error);
}

export async function updateCapabilityStatement(
  db: XosClient,
  id: string,
  input: Omit<CapabilityStatementInput, "projectId" | "direction">,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("capability_statements")
    .update({
      urid: input.urid,
      description: input.description.trim(),
      quantity: input.quantity ?? null,
      unit_basis: input.unitBasis ?? null,
      is_critical: input.critical ?? false,
      assertion_word: input.assertionWord ?? "UNKNOWN",
      venue_id: input.venueId ?? null,
      counterparty_id: input.counterpartyId ?? null,
    })
    .eq("id", id)
    .select("id");
  return writeResult(data, error);
}

export async function archiveCapabilityStatement(
  db: XosClient,
  id: string,
  now: Date = new Date(),
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("capability_statements")
    .update({ deleted_at: now.toISOString() })
    .eq("id", id)
    .select("id");
  return writeResult(data, error);
}

export interface AssertionWord {
  readonly word: string;
  readonly rank: number;
}

/** The capability assertion family (Bible tab 22) from canon, strongest first. */
export async function listCapabilityAssertionWords(
  db: XosClient,
): Promise<Result<AssertionWord[]>> {
  const { data, error } = await db
    .schema("xpms")
    .from("dim_assertion_word")
    .select("word, rank")
    .eq("domain", "capability")
    .order("rank", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(data.map((w) => ({ word: w.word, rank: w.rank })));
}

/** Runs app.reconcile_project and returns the new reconciliation id. */
export async function reconcileProject(
  db: XosClient,
  projectId: string,
  note?: string | null,
): Promise<Result<{ id: string }>> {
  const result = await callRpc<string>(db, "reconcile_project", {
    p_project_id: projectId,
    p_note: note ?? null,
  });
  return result.ok ? ok({ id: result.data }) : result;
}

export interface ReconciliationLine {
  readonly requirementId: string;
  readonly capabilityId: string | null;
  readonly result: ReconciliationResult;
}

export interface Reconciliation {
  readonly id: string;
  readonly reconciledAt: string;
  readonly note: string | null;
  readonly lines: readonly ReconciliationLine[];
}

/** The latest reconciliation of a project with its lines, or null before the first run. */
export async function getLatestReconciliation(
  db: XosClient,
  projectId: string,
): Promise<Result<Reconciliation | null>> {
  const { data, error } = await db
    .from("reconciliations")
    .select(
      "id, reconciled_at, note, reconciliation_lines(requirement_id, capability_id, result, deleted_at)",
    )
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("reconciled_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return ok(null);
  return ok({
    id: data.id,
    reconciledAt: data.reconciled_at,
    note: data.note,
    lines: data.reconciliation_lines
      .filter((l) => l.deleted_at === null)
      .map((l) => ({
        requirementId: l.requirement_id,
        capabilityId: l.capability_id,
        result: l.result,
      })),
  });
}

export interface ReconciliationSummary {
  readonly met: number;
  readonly gap: number;
  readonly unknown: number;
  /** Gate 3 gaps: every Gap and every Unknown against a critical requirement (G3.NO_CRITICAL_GAPS). */
  readonly gateGaps: number;
}

/** Counts a reconciliation's lines; the gate 3 rule matches the app.reconciliation_gaps view. */
export function summarizeReconciliation(
  lines: readonly ReconciliationLine[],
  requirements: readonly Pick<CapabilityStatement, "id" | "critical">[],
): ReconciliationSummary {
  const critical = new Set(requirements.filter((r) => r.critical).map((r) => r.id));
  let met = 0;
  let gap = 0;
  let unknown = 0;
  let gateGaps = 0;
  for (const line of lines) {
    if (line.result === "Met") met += 1;
    if (line.result === "Gap") gap += 1;
    if (line.result === "Unknown") unknown += 1;
    if (line.result === "Gap" || (line.result === "Unknown" && critical.has(line.requirementId))) {
      gateGaps += 1;
    }
  }
  return { met, gap, unknown, gateGaps };
}
