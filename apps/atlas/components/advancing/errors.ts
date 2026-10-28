/**
 * Refusal rules the Advancing pages explain with their own copy under `advancing.errors`; any other
 * refusal shows the general refusal sentence. The rules come from migration 0430 and the advancing
 * repository; each has a key in both catalogs.
 */
export const KNOWN_ERRORS: ReadonlySet<string> = new Set([
  "advance_packet_send",
  "advance_packet_sent",
  "advance_packet_no_sections",
  "advance_packet_no_recipients",
  "advance_send_authority",
  "advance_packet_sections_fixed",
  "advance_packet_unsent",
  "advance_section_open",
  "advance_recipient_duplicate",
  "advance_recipient_packet",
  "advance_submission_immutable",
  "advance_submission_reviewed",
  "advance_review_person",
  "sod_advance_submitter",
  "advance_token_email",
  "advance_token_validity",
  "reconciliation_no_requirements",
  "guest_entry_moved",
  "guest_entry_authority",
  "guest_entry_decided",
  "guest_entry_transition",
  "guest_entry_state",
  "guest_entry_stamped",
  "sod_guest_requester",
  // R2: a rider belongs to a live Artist engagement of its own project (migration 2611).
  "rider_engagement_artist",
  "same_project",
]);
