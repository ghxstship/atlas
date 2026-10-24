import type { XosClient } from "./client.ts";
import type { Json } from "./database.types.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Bulk edit (Section 11.7, ADR 0044) over the transactional bulk RPCs (migrations 1451 and 1780):
 * one property across a selection, previewed, all or nothing, with the inverse rows that undo it.
 * Each resource has its own RPC; adding one is a row function, a registry row and a name here.
 */

export const BULK_RESOURCES = [
  "records",
  "shifts",
  "invoices",
  "asset_units",
  "projects",
  "work_orders",
  "punch_items",
  "documents",
] as const;
export type BulkResource = (typeof BULK_RESOURCES)[number];

export type BulkValue = string | number | boolean | null;

/** One row of a bulk change: the values to set and, optionally, the values it must still hold. */
export interface BulkRow {
  readonly id: string;
  readonly set: Readonly<Record<string, BulkValue>>;
  readonly expect?: Readonly<Record<string, BulkValue>>;
}

/** A refused row: the database named the rule and said why. */
export interface BulkRefusal {
  readonly id: string | null;
  readonly rule: string;
  readonly message: string;
}

export interface BulkOutcome {
  readonly preview: boolean;
  /** True only when every row passed and the change was applied. */
  readonly committed: boolean;
  /** Rows the change alters (or would, in a preview). */
  readonly changed: number;
  /** Rows that already hold the values. */
  readonly unchanged: number;
  /** Rows that cannot change; any refusal means nothing was applied. */
  readonly refused: readonly BulkRefusal[];
  /** Rows that undo a committed change, sent back through the same RPC. */
  readonly inverse: readonly BulkRow[];
}

/** The same values for every selected row. */
export function sameValueRows(
  ids: readonly string[],
  set: Readonly<Record<string, BulkValue>>,
): BulkRow[] {
  return ids.map((id) => ({ id, set }));
}

function asValues(value: unknown): Record<string, BulkValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, BulkValue> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] =
      typeof v === "string" || typeof v === "number" || typeof v === "boolean"
        ? v
        : v === null
          ? null
          : JSON.stringify(v);
  }
  return out;
}

/** Reads the RPC's JSON answer into a typed outcome; anything malformed reads as empty. */
export function toBulkOutcome(raw: unknown): BulkOutcome {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const list = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v)
      ? v.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
      : [];
  return {
    preview: o["preview"] === true,
    committed: o["committed"] === true,
    changed: typeof o["changed"] === "number" ? o["changed"] : 0,
    unchanged: typeof o["unchanged"] === "number" ? o["unchanged"] : 0,
    refused: list(o["refused"]).map((r) => ({
      id: typeof r["id"] === "string" ? r["id"] : null,
      rule: typeof r["rule"] === "string" ? r["rule"] : "refused",
      message: typeof r["message"] === "string" ? r["message"] : "",
    })),
    inverse: list(o["inverse"]).flatMap((r) =>
      typeof r["id"] === "string"
        ? [{ id: r["id"], set: asValues(r["set"]), expect: asValues(r["expect"]) }]
        : [],
    ),
  };
}

const RPC = {
  records: "bulk_update_records",
  shifts: "bulk_update_shifts",
  invoices: "bulk_update_invoices",
  asset_units: "bulk_update_asset_units",
  projects: "bulk_update_projects",
  work_orders: "bulk_update_work_orders",
  punch_items: "bulk_update_punch_items",
  documents: "bulk_update_documents",
} as const satisfies Record<BulkResource, string>;

/**
 * Runs a bulk change. With `preview` nothing changes and the outcome says what would. A refusal of
 * the call itself (an empty or oversized selection) comes back as an error; refusals of rows come
 * back in the outcome.
 */
export async function bulkUpdate(
  db: XosClient,
  resource: BulkResource,
  rows: readonly BulkRow[],
  options: { readonly preview?: boolean; readonly reason?: string | null } = {},
): Promise<Result<BulkOutcome>> {
  const { data, error } = await db.rpc(RPC[resource], {
    p_rows: rows as unknown as Json,
    p_preview: options.preview ?? false,
    ...(options.reason ? { p_reason: options.reason } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok(toBulkOutcome(data));
}
