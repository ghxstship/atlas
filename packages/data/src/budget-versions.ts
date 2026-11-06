import type { XosClient } from "./client.ts";
import { extendedMinor, type BudgetLine, type BudgetLineType } from "./finance.ts";
import { fillPersonNames } from "./person-names.ts";
import { fail, ok, toDataError, type DatabaseErrorLike, type Result } from "./result.ts";

/**
 * Budget versions (G-210, ADR 0152): frozen captures of a budget's plan, to compare with the live
 * budget or another version. A Quote capture backs a sent quote and is never deleted
 * (budget_version_in_use). Plan fields only: actual and committed are never frozen. Reads go through
 * row level security; the capture is app.snapshot_budget. Money is integer minor units and null is
 * unpriced, never zero, so every delta here is null when either side is.
 */

export type BudgetVersionPurpose = "Snapshot" | "Quote";

export interface BudgetVersion {
  readonly id: string;
  readonly budgetId: string;
  readonly versionNumber: number;
  readonly label: string;
  readonly purpose: BudgetVersionPurpose;
  readonly currency: string;
  readonly createdAt: string;
  readonly createdByName: string | null;
  readonly createdBy: string | null;
}

export interface BudgetVersionLine {
  readonly budgetLineId: string;
  readonly lineNumber: number;
  readonly description: string;
  readonly lineType: BudgetLineType;
  readonly urid: string;
  readonly quantity: number;
  readonly unitBasis: string | null;
  readonly unitPriceMinor: number | null;
  readonly effectiveMarkupBp: number | null;
  readonly clientUnitPriceMinor: number | null;
  readonly excludedFromQuote: boolean;
}

type Raw = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : typeof v === "number" ? v : Number(v);

async function rows<T>(
  query: PromiseLike<{ data: unknown; error: DatabaseErrorLike | null }>,
  map: (row: Raw) => T,
): Promise<Result<T[]>> {
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok(((data as Raw[] | null) ?? []).map(map));
}

/** A budget's live versions, newest first, with who took each. */
export async function listBudgetVersions(
  db: XosClient,
  budgetId: string,
): Promise<Result<BudgetVersion[]>> {
  const result = await rows(
    db
      .from("budget_versions")
      .select("id, budget_id, version_number, label, purpose, currency_code, created_at, created_by")
      .eq("budget_id", budgetId)
      .is("deleted_at", null)
      .order("version_number", { ascending: false }),
    (r): BudgetVersion => ({
      id: str(r["id"]),
      budgetId: str(r["budget_id"]),
      versionNumber: num(r["version_number"]),
      label: str(r["label"]),
      purpose: str(r["purpose"]) as BudgetVersionPurpose,
      currency: str(r["currency_code"]),
      createdAt: str(r["created_at"]),
      createdBy: strOrNull(r["created_by"]),
      createdByName: null,
    }),
  );
  if (!result.ok) return result;
  return ok(
    await fillPersonNames(
      db,
      result.data,
      (v) => v.createdBy,
      (v) => v.createdByName,
      (v, name) => ({ ...v, createdByName: name }),
    ),
  );
}

/** A version's frozen lines in line order. */
export async function getBudgetVersionLines(
  db: XosClient,
  versionId: string,
): Promise<Result<BudgetVersionLine[]>> {
  return rows(
    db
      .from("budget_version_lines")
      .select(
        "budget_line_id, line_number, description, line_type, urid, quantity, unit_basis, unit_price_minor, effective_markup_bp, client_unit_price_minor, excluded_from_quote",
      )
      .eq("budget_version_id", versionId)
      .order("line_number"),
    (r): BudgetVersionLine => ({
      budgetLineId: str(r["budget_line_id"]),
      lineNumber: num(r["line_number"]),
      description: str(r["description"]),
      lineType: str(r["line_type"]) as BudgetLineType,
      urid: str(r["urid"]),
      quantity: num(r["quantity"]),
      unitBasis: strOrNull(r["unit_basis"]),
      unitPriceMinor: numOrNull(r["unit_price_minor"]),
      effectiveMarkupBp: numOrNull(r["effective_markup_bp"]),
      clientUnitPriceMinor: numOrNull(r["client_unit_price_minor"]),
      excludedFromQuote: r["excluded_from_quote"] === true,
    }),
  );
}

/** Take snapshot: app.snapshot_budget freezes every live line. Needs finance.budget.write. */
export async function snapshotBudget(
  db: XosClient,
  budgetId: string,
  label: string,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db.rpc("snapshot_budget", {
    p_budget_id: budgetId,
    p_label: label.trim(),
  });
  if (error) return fail(toDataError(error));
  return ok({ id: data });
}

/** Moves a Snapshot version to Trash; a Quote capture refuses budget_version_in_use. */
export async function deleteBudgetVersion(db: XosClient, id: string): Promise<Result<null>> {
  const { error } = await db
    .from("budget_versions")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  return error ? fail(toDataError(error)) : ok(null);
}

/** Restores a Snapshot version, for the Undo toast. */
export async function restoreBudgetVersion(db: XosClient, id: string): Promise<Result<null>> {
  const { error } = await db.from("budget_versions").update({ deleted_at: null }).eq("id", id);
  return error ? fail(toDataError(error)) : ok(null);
}

// Compare ---------------------------------------------------------------------------------------------

export type CompareStatus = "added" | "removed" | "changed" | "unchanged";
export type CompareField =
  | "description"
  | "quantity"
  | "unitPrice"
  | "lineType"
  | "urid"
  | "markup"
  | "clientPrice";

/** One side of a comparison: a version's frozen line, or a live line through liveCompareLine. */
export type CompareLine = BudgetVersionLine;

export interface LineComparison {
  readonly budgetLineId: string;
  readonly lineNumber: number;
  readonly description: string;
  readonly status: CompareStatus;
  readonly changed: readonly CompareField[];
  readonly costBeforeMinor: number | null;
  readonly costAfterMinor: number | null;
  /** Null when either side is unpriced; a line missing from one side counts as zero there. */
  readonly costDeltaMinor: number | null;
  readonly clientBeforeMinor: number | null;
  readonly clientAfterMinor: number | null;
  readonly clientDeltaMinor: number | null;
}

export interface BudgetComparison {
  readonly lines: readonly LineComparison[];
  /** Null when any line on either side is unpriced. */
  readonly costDeltaMinor: number | null;
  readonly clientDeltaMinor: number | null;
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
}

/** A live budget line in the shape of a frozen one, so `to` may be the live budget. */
export function liveCompareLine(line: BudgetLine): CompareLine {
  return {
    budgetLineId: line.id,
    lineNumber: line.lineNumber,
    description: line.description,
    lineType: line.lineType,
    urid: line.urid,
    quantity: line.quantity,
    unitBasis: line.unitBasis,
    unitPriceMinor: line.unitPriceMinor,
    effectiveMarkupBp: line.effectiveMarkupBp,
    clientUnitPriceMinor: line.effectiveClientUnitPriceMinor,
    excludedFromQuote: line.excludedFromQuote,
  };
}

const delta = (before: number | null, after: number | null) =>
  before === null || after === null ? null : after - before;

function changedFields(from: CompareLine, to: CompareLine): CompareField[] {
  const fields: CompareField[] = [];
  if (from.description !== to.description) fields.push("description");
  if (from.quantity !== to.quantity) fields.push("quantity");
  if (from.unitPriceMinor !== to.unitPriceMinor) fields.push("unitPrice");
  if (from.lineType !== to.lineType) fields.push("lineType");
  if (from.urid !== to.urid) fields.push("urid");
  if (from.effectiveMarkupBp !== to.effectiveMarkupBp) fields.push("markup");
  if (from.clientUnitPriceMinor !== to.clientUnitPriceMinor) fields.push("clientPrice");
  return fields;
}

/**
 * Compares two sets of lines by budget line id. Totals are null-aware: an unpriced line on either
 * side blanks the total's delta, and a line only on one side counts as zero on the other.
 */
export function compareBudgetLines(
  from: readonly CompareLine[],
  to: readonly CompareLine[],
): BudgetComparison {
  const before = new Map(from.map((l) => [l.budgetLineId, l]));
  const after = new Map(to.map((l) => [l.budgetLineId, l]));
  const ids = [...new Set([...before.keys(), ...after.keys()])];
  const lines = ids.map((id): LineComparison => {
    const a = before.get(id);
    const b = after.get(id);
    const shown = (b ?? a) as CompareLine;
    const costBefore = a ? extendedMinor(a.quantity, a.unitPriceMinor) : 0;
    const costAfter = b ? extendedMinor(b.quantity, b.unitPriceMinor) : 0;
    const clientBefore = a ? extendedMinor(a.quantity, a.clientUnitPriceMinor) : 0;
    const clientAfter = b ? extendedMinor(b.quantity, b.clientUnitPriceMinor) : 0;
    const changed = a && b ? changedFields(a, b) : [];
    return {
      budgetLineId: id,
      lineNumber: shown.lineNumber,
      description: shown.description,
      status: !a ? "added" : !b ? "removed" : changed.length > 0 ? "changed" : "unchanged",
      changed,
      costBeforeMinor: costBefore,
      costAfterMinor: costAfter,
      costDeltaMinor: delta(costBefore, costAfter),
      clientBeforeMinor: clientBefore,
      clientAfterMinor: clientAfter,
      clientDeltaMinor: delta(clientBefore, clientAfter),
    };
  });
  lines.sort((x, y) => x.lineNumber - y.lineNumber);
  const total = (pick: (l: LineComparison) => number | null) => {
    let sum = 0;
    for (const line of lines) {
      const value = pick(line);
      if (value === null) return null;
      sum += value;
    }
    return sum;
  };
  return {
    lines,
    costDeltaMinor: total((l) => l.costDeltaMinor),
    clientDeltaMinor: total((l) => l.clientDeltaMinor),
    added: lines.filter((l) => l.status === "added").length,
    removed: lines.filter((l) => l.status === "removed").length,
    changed: lines.filter((l) => l.status === "changed").length,
  };
}
