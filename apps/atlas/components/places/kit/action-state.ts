import type { DataError } from "@xos/data";

/**
 * What a Places or Safety server action returns to its form. Errors are catalog keys under
 * `places.errors`, so every refusal the database names reaches the person in their language with the
 * next action; a refusal with no catalog entry falls back to the generic refusal copy, never to
 * silence.
 */
export interface ActionState {
  readonly ok?: boolean;
  readonly error?: string;
  readonly fieldErrors?: Readonly<Record<string, string>>;
  readonly id?: string;
}

export const INITIAL_STATE: ActionState = {};

/** Refusal rules (ADR 0008, SQLSTATE XR001) with their own copy in `places.errors`. */
const KNOWN_REFUSALS = new Set([
  "capability_document_frozen",
  "jurisdiction_no_answer",
  "permit_requirement_tracked",
  "inspection_signed_off",
  "inspection_item_template",
  "inspection_inspector_immutable",
  "sod_approval_requester",
  "venue_location_pair",
  "venue_location_range",
  "time_zone_unknown",
  "record_blocker_required",
  "record_replan_reason_required",
  "record_title_grammar",
  "record_transition_not_allowed",
  "record_state_conflict",
  "transition_reason_required",
  "production_closed",
  "enumeration_domain",
  // B1 site plans, levels, specs and signs (2900 to 2905, ADR 0140).
  "site_plan_locked",
  "site_plan_archived",
  "site_plan_no_drawing",
  "site_plan_live_exists",
  "site_plan_transition_not_allowed",
  "site_plan_state_conflict",
  "site_plan_initial_state",
  "site_plan_transition_rpc_only",
  "site_plan_level_venue",
  "space_level_venue",
  "venue_level_reorder",
  "venue_level_venue_immutable",
  "site_plan_drawing_subject",
  "site_plan_drawing_scan",
  "site_plan_drawing_type",
  "site_plan_raster_required",
  "site_plan_raster_attachment",
  "site_plan_drawing_page",
  "site_plan_drawing_classification",
  "site_plan_dimensions_fixed",
  "site_plan_shape_geometry",
  "site_plan_shape_plan_immutable",
  "site_plan_anchor",
  "place_spec_target",
  "place_spec_document_venue",
  "place_spec_capability_managed",
  "project_no_venue",
  "sign_pin_project",
  "sign_po_line_project",
  "sign_po_line_read",
  "sign_artwork_subject",
  "sign_step_rpc_only",
  "sign_ordered_by_po",
  "sign_ordered_manually",
  "sign_placed_needs_location",
  "sign_number_immutable",
  "sign_project_immutable",
]);

export function errorKey(error: DataError): string {
  switch (error.kind) {
    case "refusal":
      return KNOWN_REFUSALS.has(error.rule) ? error.rule : "refused";
    case "not-found":
      return "notFound";
    case "conflict":
      return "conflict";
    case "invalid":
      return "invalid";
    default:
      return "unexpected";
  }
}

/** Reads a trimmed string field; empty becomes null. */
export function text(form: FormData, key: string): string | null {
  const value = form.get(key);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Reads a non-negative number field; empty is null (unknown), never zero (Section 3.7). */
export function count(form: FormData, key: string): number | null | "invalid" {
  const raw = text(form, key);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : "invalid";
}
