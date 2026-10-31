/**
 * Advance tracks in the public API (R11, RRR-192; parity gap G-176, migration 2743). Additive only (v1 is frozen,
 * Section 10.1):
 *
 *   * `advanceSections.setTrack`: moves a section to another track; a grouping label, editable after send.
 *   * `advanceRecipients.signOffTrack`: a reviewer signs off one recipient's track once every section on it is done.
 *   * `advanceTrackSignoffs`: the sign-offs, read only, with the `revoke` action.
 *   * `advanceTrackProgress`: each recipient's computed track state (app.advance_track_progress), read only.
 *
 * The `track` field enters the frozen `advanceSections` through the `advance-section-track` correction in
 * catalog/modules/advancing.ts.
 */
import { z } from "@hono/zod-openapi";
import { defineResource, fields } from "@xos/schemas";
import type { CapabilityRule } from "../../capabilities.ts";
import { editDefinition, orNull } from "../../correct.ts";
import { itemAction, resource } from "../../define.ts";
import type { ActionSpec, ResourceSpec } from "../../types.ts";

export const ADVANCE_TRACKS = [
  "Finance",
  "Technical",
  "Hospitality",
  "Catering",
  "Travel",
  "Logistics",
  "General",
] as const;

export const TRACK_STATES = [
  "Not Started",
  "In Progress",
  "Ready for Sign-off",
  "Signed Off",
  "Reopened",
] as const;

const Track = z.enum(ADVANCE_TRACKS);

const trackBody = (id: string, description: string) =>
  z
    .object({
      track: Track.meta({ description: "The track.", example: "Hospitality" }),
    })
    .meta({ id, description });

const AdvanceTrackSignoff = editDefinition(
  defineResource({
    name: "AdvanceTrackSignoff",
    table: "app.advance_track_signoffs",
    description:
      "A reviewer's sign-off of one recipient's track of an advance packet (R11, G-176): every section on the track was accepted, complete or not applicable when it was signed. The signer is `created_by`. A revoked sign-off keeps its row with the reason; the track's state is computed in advanceTrackProgress.",
    fields: {
      advance_recipient_id: fields.ref("recipient whose track was signed off"),
      track: Track.meta({ description: "Track signed off.", example: "Hospitality" }),
      signed_off_at: fields.instant("When the track was signed off."),
      revoked_at: orNull(fields.instant("When the sign-off was revoked; null while it stands.")),
      revoke_reason: orNull(
        fields.text("Why it was revoked.", "The power answer came in after sign-off.", 500),
      ),
    },
    serverSet: ["advance_recipient_id", "track", "signed_off_at", "revoked_at", "revoke_reason"],
  }),
  { nullable: ["created_by", "updated_by"] },
);

const AdvanceTrackProgress = defineResource({
  name: "AdvanceTrackProgress",
  table: "app.advance_track_progress",
  base: "view",
  key: "advance_recipient_id",
  description:
    "Where each recipient of a sent advance packet stands on each track (R11, G-176): one row per packet, recipient and track with a live section. `track_state` is computed from the answers and the live sign-off, never stored.",
  fields: {
    org_id: fields.ref("org that sent the packet"),
    project_id: fields.ref("project of the packet"),
    advance_packet_id: fields.ref("packet"),
    advance_recipient_id: fields.ref("recipient"),
    recipient_label: orNull(fields.text("The recipient's name.", "Bayside Audio", 200)),
    track: Track.meta({ description: "Track.", example: "Hospitality" }),
    sections_total: fields.int("Live sections on the track.", 2, 0),
    sections_done: fields.int("Sections Accepted, Complete or Not Applicable.", 2, 0),
    sections_outstanding: fields.int("Sections not done yet.", 0, 0),
    overdue: fields.bool("True when a section on the track is overdue.", false),
    signoff_id: orNull(fields.ref("live sign-off")),
    signed_off_at: orNull(fields.instant("When the track was signed off.")),
    signed_off_by_name: orNull(fields.text("Who signed it off.", "Carol Nguyen", 200)),
    track_state: z.enum(TRACK_STATES).meta({
      description:
        "Not Started, In Progress, Ready for Sign-off, Signed Off, or Reopened (a section no longer done or an answer newer than the sign-off).",
      example: "Ready for Sign-off",
    }),
  },
});

export const advanceTrackResources: readonly ResourceSpec[] = [
  resource("Advancing", "/advance-track-signoffs", AdvanceTrackSignoff, {
    verbs: ["list", "get"],
    label: "track sign-off",
    actions: [
      itemAction("revoke", {
        summary: "Revoke a track sign-off",
        description:
          "Revokes a live sign-off through `app.revoke_advance_track_signoff` with a reason of 1 to 500 characters (422 advance_track_revoke_reason); the row stays and the track can be signed off again. Needs advancing.submission.review on the project.",
        body: z
          .object({
            reason: z.string().min(1).max(500).meta({
              description: "Why the sign-off is revoked.",
              example: "The power answer came in after sign-off.",
            }),
          })
          .meta({ id: "AdvanceTrackSignoffRevokeRequest", description: "Revoking a sign-off." }),
        rpc: "app.revoke_advance_track_signoff",
      }),
    ],
  }),
  resource("Advancing", "/advance-track-progress", AdvanceTrackProgress, {
    verbs: ["list"],
    label: "track progress",
    order: { by: ["advance_recipient_id"], numeric: false },
  }),
];

export const advanceTrackActions: Readonly<Record<string, readonly ActionSpec[]>> = {
  advanceSections: [
    itemAction("setTrack", {
      summary: "Move a section to another track",
      description:
        "Sets the track a section is grouped under (Finance, Technical, Hospitality, Catering, Travel, Logistics or General). A grouping label: it stays editable after the packet is sent. With If-Match, a stale section is refused (412).",
      body: trackBody("AdvanceSectionSetTrackRequest", "The track a section moves to."),
      etag: true,
    }),
  ],
  advanceRecipients: [
    itemAction("signOffTrack", {
      summary: "Sign off a recipient's track",
      description:
        "Signs off one track of a sent packet's recipient through `app.sign_off_advance_track`, once every live section on it is Accepted, Complete or Not Applicable. Refuses a track with no section (422 advance_track_empty), one not done (advance_track_incomplete), one already signed off (advance_track_signed_off) and an unsent packet (advance_packet_unsent). Needs advancing.submission.review on the project. Returns the sign-off.",
      body: trackBody("AdvanceRecipientSignOffTrackRequest", "The track to sign off."),
      response: AdvanceTrackSignoff.read,
      status: 201,
      rpc: "app.sign_off_advance_track",
    }),
  ],
};

export const advanceTrackCapabilities: Readonly<Record<string, CapabilityRule>> = {
  advanceSections: { actions: { setTrack: "advancing.packet.write" } },
  advanceRecipients: { actions: { signOffTrack: "advancing.submission.review" } },
  advanceTrackSignoffs: {
    read: "advancing.packet.read",
    actions: { revoke: "advancing.submission.review" },
  },
  advanceTrackProgress: { read: "advancing.packet.read" },
};
