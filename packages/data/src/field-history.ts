import type { XosClient } from "./client.ts";
import type { Json } from "./database.types.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Field history (Section 4.10, ADR 0044, ADR 0090): who changed which field of a row and when, from
 * the audit ledger through app.field_history (migrations 1452, 2061 and 2240), one event per row
 * (2061). Only someone who can read the row gets it, and a Restricted field arrives masked, with
 * neither value. A record's history also carries its kind attributes (its app.record_<kind> row),
 * named `attributes.<column>`.
 */

/**
 * The tables whose rows have a field history: private.field_history_subjects (migrations 1452,
 * 2100 and 2241). Asking for any other table is refused, so pages render the history only for these.
 */
export const FIELD_HISTORY_SUBJECTS: ReadonlySet<string> = new Set([
  "app.accommodation_blocks",
  "app.accounting_periods",
  "app.advance_packets",
  "app.advance_submissions",
  "app.agreements",
  "app.applications",
  "app.asset_classes",
  "app.asset_damage",
  "app.asset_lots",
  "app.asset_maintenance",
  "app.asset_units",
  "app.beos",
  "app.budgets",
  "app.call_sheets",
  "app.canon_extension_proposals",
  "app.capability_documents",
  "app.catalog_bindings",
  "app.change_orders",
  "app.cost_centers",
  "app.credential_categories",
  "app.credentials",
  "app.custom_object_records",
  "app.day_sheets",
  "app.dock_slots",
  "app.documents",
  "app.engagements",
  "app.expenses",
  "app.feed_posts",
  "app.fulfillments",
  "app.goods_receipts",
  "app.groups",
  "app.guest_list_entries",
  "app.handbook_articles",
  "app.incidents",
  "app.inspection_templates",
  "app.inspections",
  "app.insurance_certificates",
  "app.invoice_matches",
  "app.invoices",
  "app.journal_entries",
  "app.lost_found_items",
  "app.offers",
  "app.opportunities",
  "app.pay_periods",
  "app.payments",
  "app.payroll_runs",
  "app.permit_requirements",
  "app.prequalifications",
  "app.purchase_orders",
  "app.radio_channels",
  "app.rate_cards",
  "app.reconciliations",
  "app.records",
  "app.requisitions",
  "app.rfqs",
  "app.riders",
  "app.run_of_show",
  "app.schedule_baselines",
  "app.settlements",
  "app.shift_swaps",
  "app.shifts",
  "app.shipments",
  "app.site_plans",
  "app.sops",
  "app.spaces",
  "app.sponsor_entitlements",
  "app.submittals",
  "app.time_off_requests",
  "app.timesheets",
  "app.vendor_scorecards",
  "app.vendors",
  "app.venues",
  "app.work_orders",
  "app.workforce_events",
  "app.zones",
]);

/** Whether rows of `table` (schema-qualified) have a field history. */
export function hasFieldHistory(table: string): boolean {
  return FIELD_HISTORY_SUBJECTS.has(table);
}

/** The prefix of a record's kind attribute fields in its history (migration 2240). */
export const ATTRIBUTE_FIELD_PREFIX = "attributes.";

/** The attribute column a history field names (`attributes.progress_pct`), or null for the record's own fields. */
export function attributeColumn(field: string): string | null {
  return field.startsWith(ATTRIBUTE_FIELD_PREFIX)
    ? field.slice(ATTRIBUTE_FIELD_PREFIX.length)
    : null;
}

export interface FieldChange {
  readonly field: string;
  /** The stored value before and after, as JSON; null for a masked field. */
  readonly before: Json | null;
  readonly after: Json | null;
  readonly masked: boolean;
}

export interface HistoryEvent {
  readonly id: string;
  readonly at: string;
  readonly actorId: string | null;
  readonly actorName: string | null;
  readonly operation: "insert" | "update" | "delete";
  readonly changes: readonly FieldChange[];
}

interface HistoryChangeRow {
  readonly field: string;
  readonly old_value: Json | null;
  readonly new_value: Json | null;
  readonly masked: boolean;
}

interface HistoryEventRow {
  readonly event_id: string;
  readonly changed_at: string;
  readonly actor_person_id: string | null;
  readonly actor_name: string | null;
  readonly operation: string;
  readonly changes: Json;
}

/** Maps the RPC's rows (one per event, newest first, changed fields as a JSON array) to events. */
export function toHistoryEvents(rows: readonly HistoryEventRow[]): HistoryEvent[] {
  return rows.map((row) => ({
    id: row.event_id,
    at: row.changed_at,
    actorId: row.actor_person_id,
    actorName: row.actor_name,
    operation: row.operation === "insert" || row.operation === "delete" ? row.operation : "update",
    changes: (Array.isArray(row.changes) ? (row.changes as unknown as HistoryChangeRow[]) : []).map(
      (c) => ({
        field: c.field,
        before: c.masked ? null : c.old_value,
        after: c.masked ? null : c.new_value,
        masked: c.masked,
      }),
    ),
  }));
}

/**
 * The field history of one row, at most `limit` events (1 to 1,000). app.field_history_events
 * (2061) answers one row per event, so the API's row cap (max_rows, 1,000) never cuts an event
 * short or drops the oldest ones.
 */
export async function getFieldHistory(
  db: XosClient,
  table: string,
  id: string,
  limit = 200,
): Promise<Result<HistoryEvent[]>> {
  const { data, error } = await db.rpc("field_history_events", {
    p_subject_table: table,
    p_subject_id: id,
    p_limit: limit,
  });
  if (error) return fail(toDataError(error));
  return ok(toHistoryEvents(data ?? []));
}
