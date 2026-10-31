import type { DataError } from "@xos/data";

/**
 * What a Schedule, Work or Show server action returns: success with an optional payload, or an
 * error named by a catalog key under `work.errors` (with the database's own sentence as detail for
 * refusals that carry a correction, such as title grammar). No error path is silent.
 */
export type ActionResult<T = null> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: ActionError };

export interface ActionError {
  /** Key under `work.errors`. */
  readonly key: string;
  /** The database's correction sentence, shown under the catalog message when present. */
  readonly detail?: string;
}

/** Refusal rules the catalogs explain; any other refusal shows the generic refusal copy. */
const EXPLAINED = new Set([
  "record_title_grammar",
  "record_xyz_required",
  "record_xyz_basis",
  "record_blocker_required",
  "record_replan_reason_required",
  "record_transition_not_allowed",
  "record_state_conflict",
  "record_retained",
  "record_scope_project",
  "transition_reason_required",
  "dependency_cycle",
  "dependency_project",
  "baseline_locked",
  "cue_already_called",
  "cue_call_capability",
  "cue_move_called",
  "cue_move_before_called",
  "cue_standby_called",
  "cue_standby_capability",
  "cue_shift_range",
  "cue_call_kind",
  "sheet_publish_capability",
  "sod_work_order_award",
  "work_order_award_unpriced",
  "work_order_award_withdrawn",
  "work_order_award_bid",
  "work_order_award_rpc_only",
  "work_order_transition_not_allowed",
  "work_order_state_conflict",
  "work_order_retained",
  "bid_window_closed",
  "bid_awarded",
  "bid_withdrawn",
  "punch_item_what_required",
  "same_project",
  "sod_approval_requester",
  "approval_decided",
  "approval_not_eligible",
  "time_zone_unknown",
  // B3 (ADR 0142): segments, show channels and showcaller links.
  "segment_insert_before_called",
  "segment_insert_cue_limit",
  "segment_library_empty",
  "segment_publish_runs",
  "segment_library_cue_limit",
  "segment_color_key",
  "segment_color_segment",
  "show_channel_client",
  "showcaller_link_capability",
  "showcaller_link_limit",
  "showcaller_link_expiry_range",
  "showcaller_link_caller_name",
  "showcaller_link_revoked",
  "org_read_only",
]);

/** Refusals whose database sentence is the correction the person needs. */
const WITH_DETAIL = new Set(["record_title_grammar", "record_xyz_basis"]);

export function toActionError(error: DataError): ActionError {
  switch (error.kind) {
    case "refusal":
      if (!EXPLAINED.has(error.rule)) return { key: "refused", detail: error.message };
      return WITH_DETAIL.has(error.rule)
        ? { key: `rules.${error.rule}`, detail: error.message }
        : { key: `rules.${error.rule}` };
    case "not-found":
      return { key: "notFound" };
    case "conflict":
      return { key: "conflict" };
    case "invalid":
      return { key: "invalid" };
    default:
      return { key: "unexpected" };
  }
}

export function done<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

export function failed<T = null>(error: DataError): ActionResult<T> {
  return { ok: false, error: toActionError(error) };
}

export function invalid<T = null>(key = "invalid"): ActionResult<T> {
  return { ok: false, error: { key } };
}
