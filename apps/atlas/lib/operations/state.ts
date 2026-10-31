import type { DataError } from "@xos/data";

/**
 * The state every Credentials and Safety incident action returns to its form. `error` is a key
 * under `credentials.errors` in the message catalogs: the database names each refusal by rule
 * (ADR 0008), and the rules these pages can meet have their own sentence there.
 */
export interface ActionState {
  readonly ok?: boolean;
  readonly error?: string;
  /** A value to show after success, such as the issued credential number or a scan decision. */
  readonly result?: Readonly<Record<string, string>>;
}

export const INITIAL_STATE: ActionState = {};

/** Refusal rules with a sentence in `credentials.errors.rules`. */
export const KNOWN_RULES = [
  "credential_self_issue",
  "credential_immutable",
  "credential_revoked",
  "credential_unknown",
  "credential_engagement_project",
  "credential_engagement_holder",
  "credential_engagement_closed",
  "credential_category_kind_in_use",
  "person_not_on_project",
  "scan_id_taken",
  "scan_intake_resolved",
  "scan_intake_dismiss_note",
  "scan_device_time_future",
  "scan_offline_needs_time",
  "project_copy_immutable",
  "enumeration_domain",
  "production_closed",
  "transition_reason_required",
  "incident_transition_not_allowed",
  "incident_state_conflict",
  "incident_relabel_and_close",
  "incident_closed",
  "incident_close_rpc",
  "incident_signoff_rpc",
  "incident_reporter_immutable",
  "incident_device_time_future",
  "sod_approval_requester",
  "medical_capability_required",
  "incident_id_taken",
  "incident_party_id_taken",
  "incident_media_id_taken",
  "dispatch_id_taken",
  // P5 badge photos (2822).
  "credential_photo_batch_size",
  "credential_photo_path",
  "credential_photo_no_credential",
  "credential_photo_not_issuer",
  "credential_photo_scanning",
  "credential_photo_unscanned",
] as const;

const KNOWN = new Set<string>(KNOWN_RULES);

/** The catalog key for a repository error. */
export function errorKey(error: DataError): string {
  switch (error.kind) {
    case "refusal":
      return KNOWN.has(error.rule) ? `rules.${error.rule}` : "refused";
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

/** The action state for a failed repository result. */
export function failed(error: DataError): ActionState {
  return { error: errorKey(error) };
}
