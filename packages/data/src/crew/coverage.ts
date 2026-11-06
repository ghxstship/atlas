import type { Database, XosClient } from "../client.ts";
import { fail, ok, toDataError, type Result } from "../result.ts";

/**
 * Crew coverage (B9, migrations 2980 to 2982 and 2986; ADR 0148): the asks a person answers about a shift, no-shows, and
 * the one list of what is not covered yet. A no-show is an outcome record and an ask is a fact, so neither touches the
 * shift's lifecycle. Atlas, Gateway and Compass share these; row level security and the RPCs decide every row.
 */

export type ShiftAskKind = Database["app"]["Enums"]["shift_ask_kind"];
export type ShiftAnswer = Database["app"]["Enums"]["shift_answer"];

/** What app.crew_shortages reports, in the order Crew > Shortages counts them. */
export const SHORTAGE_KINDS = [
  "open",
  "agency_unfilled",
  "awaiting_answer",
  "not_reconfirmed",
  "reconfirm_declined",
  "no_show",
  "vendor_unconfirmed",
] as const;
export type ShortageKind = (typeof SHORTAGE_KINDS)[number];

function shortageKind(value: string): ShortageKind {
  return (SHORTAGE_KINDS as readonly string[]).includes(value) ? (value as ShortageKind) : "open";
}

/** One row of Crew > Shortages: a shift, or a labor line of a purchase order the vendor has not acknowledged. */
export interface Shortage {
  readonly kind: ShortageKind;
  readonly projectId: string;
  readonly projectName: string;
  /** Null for a vendor row. */
  readonly shiftId: string | null;
  /** Null for a shift row. */
  readonly poLineId: string | null;
  /** The order a vendor row's line is on, which its link opens. */
  readonly purchaseOrderId: string | null;
  readonly roleCode: string | null;
  readonly startsAt: string;
  readonly endsAt: string | null;
  /** The zone its day buckets in: the shift's, or for a vendor row the project's. */
  readonly timeZone: string;
  /** The agency or vendor. */
  readonly partyName: string | null;
  /** The worker, when the caller may know them by name. */
  readonly personName: string | null;
  readonly quantity: number | null;
  /** A position's title, a decline's or no-show's reason, or a line's description. */
  readonly detail: string | null;
  readonly askedAt: string | null;
}

export interface ShortageFilter {
  readonly orgId: string;
  /** First day, YYYY-MM-DD. */
  readonly from: string;
  /** Last day, YYYY-MM-DD; at most 62 days in all (crew_shortages_range). */
  readonly to: string;
}

/** What is not covered yet in the org between two days (app.crew_shortages), by start time then project. */
export async function listShortages(
  db: XosClient,
  filter: ShortageFilter,
): Promise<Result<Shortage[]>> {
  const { data, error } = await db.rpc("crew_shortages", {
    p_org_id: filter.orgId,
    p_from: filter.from,
    p_to: filter.to,
  });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({
      kind: shortageKind(r.kind),
      projectId: r.project_id,
      projectName: r.project_name,
      shiftId: r.shift_id ?? null,
      poLineId: r.po_line_id ?? null,
      purchaseOrderId: r.purchase_order_id ?? null,
      roleCode: r.role_code ?? null,
      startsAt: r.starts_at,
      endsAt: r.ends_at ?? null,
      timeZone: r.time_zone,
      partyName: r.party_name ?? null,
      personName: r.person_name ?? null,
      quantity: r.quantity === null || r.quantity === undefined ? null : Number(r.quantity),
      detail: r.detail ?? null,
      askedAt: r.asked_at ?? null,
    })),
  );
}

/** Counts per kind, for the page's filter and summary. */
export function shortageCounts(rows: readonly Shortage[]): Map<ShortageKind, number> {
  const counts = new Map<ShortageKind, number>();
  for (const row of rows) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
  return counts;
}

/**
 * Marks the worker of a started shift as a no-show (app.mark_shift_no_show): idempotent on `id`, which the client
 * chooses, so a retry returns the same row.
 */
export async function markNoShow(
  db: XosClient,
  input: {
    readonly id: string;
    readonly shiftId: string;
    readonly reason: string;
    readonly openReplacement?: boolean;
  },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db.rpc("mark_shift_no_show", {
    p_no_show_id: input.id,
    p_shift_id: input.shiftId,
    p_reason: input.reason,
    p_open_replacement: input.openReplacement ?? false,
  });
  if (error) return fail(toDataError(error));
  return ok({ id: data });
}

/** Withdraws a live no-show (app.withdraw_shift_no_show); a reason is required. */
export async function withdrawNoShow(
  db: XosClient,
  id: string,
  reason: string,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db.rpc("withdraw_shift_no_show", {
    p_no_show_id: id,
    p_reason: reason,
  });
  if (error) return fail(toDataError(error));
  return ok({ id: data });
}

/** The person asked "Still coming?" answers (app.respond_shift_reconfirmation). */
export async function respondReconfirmation(
  db: XosClient,
  shiftId: string,
  coming: boolean,
  reason?: string | null,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db.rpc("respond_shift_reconfirmation", {
    p_shift_id: shiftId,
    p_coming: coming,
    ...(reason ? { p_reason: reason } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok({ id: data });
}

/** One ask of one person about a shift, and their answer. */
export interface ShiftResponse {
  readonly id: string;
  readonly shiftId: string;
  readonly personId: string;
  readonly kind: ShiftAskKind;
  readonly answer: ShiftAnswer;
  readonly askedAt: string;
  readonly answeredAt: string | null;
  readonly reason: string | null;
}

const RESPONSE_SELECT = "id, shift_id, person_id, ask_kind, answer, asked_at, answered_at, reason";

type ResponseRow = Pick<
  Database["app"]["Tables"]["shift_responses"]["Row"],
  "id" | "shift_id" | "person_id" | "ask_kind" | "answer" | "asked_at" | "answered_at" | "reason"
>;

function toResponse(row: ResponseRow): ShiftResponse {
  return {
    id: row.id,
    shiftId: row.shift_id,
    personId: row.person_id,
    kind: row.ask_kind,
    answer: row.answer,
    askedAt: row.asked_at,
    answeredAt: row.answered_at,
    reason: row.reason,
  };
}

/** The asks of a shift the caller may read, newest first. */
export async function listShiftResponses(
  db: XosClient,
  shiftId: string,
): Promise<Result<ShiftResponse[]>> {
  const { data, error } = await db
    .from("shift_responses")
    .select(RESPONSE_SELECT)
    .eq("shift_id", shiftId)
    .is("deleted_at", null)
    .order("asked_at", { ascending: false })
    .order("id", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(data.map(toResponse));
}

/** A live no-show as its shift's record shows it. */
export interface ShiftNoShow {
  readonly id: string;
  readonly reason: string;
  readonly recordedAt: string;
  readonly replacementShiftId: string | null;
}

/** What a shift's record shows beside its state: its live no-show and its latest Offer and Reconfirmation. */
export interface ShiftOutcome {
  readonly noShow: ShiftNoShow | null;
  readonly offer: ShiftResponse | null;
  readonly reconfirmation: ShiftResponse | null;
}

export async function getShiftOutcome(
  db: XosClient,
  shiftId: string,
): Promise<Result<ShiftOutcome>> {
  const [responses, noShow] = await Promise.all([
    listShiftResponses(db, shiftId),
    db
      .from("shift_no_shows")
      .select("id, reason, recorded_at, replacement_shift_id")
      .eq("shift_id", shiftId)
      .is("deleted_at", null)
      .maybeSingle(),
  ]);
  if (!responses.ok) return responses;
  if (noShow.error) return fail(toDataError(noShow.error));
  return ok({
    noShow: noShow.data
      ? {
          id: noShow.data.id,
          reason: noShow.data.reason,
          recordedAt: noShow.data.recorded_at,
          replacementShiftId: noShow.data.replacement_shift_id,
        }
      : null,
    offer: responses.data.find((r) => r.kind === "Offer") ?? null,
    reconfirmation: responses.data.find((r) => r.kind === "Reconfirmation") ?? null,
  });
}
