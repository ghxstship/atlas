/**
 * Advancing operations beyond the frozen v1 catalog (additive only, Section 10.1), and corrections
 * to the frozen Advancing resources (ADR 0023). See "Adding operations" and "Correcting the frozen
 * contract" in packages/api/README.md.
 *
 * Packets have no stored lifecycle: Draft, Awaiting, Overdue, In Review and Complete are derived
 * from `sent_at`, `due_at` and the answers, so the frozen `advance_state` and its transition action
 * are removed and sending stays the `send` action (app.send_advance_packet, 0430).
 */
import { z } from "@hono/zod-openapi";
import { defineResource, fields } from "@xos/schemas";
import { defineAdditions } from "../additions.ts";
import {
  all,
  editDefinition,
  editShape,
  orNull,
  putActions,
  removeActions,
  setCapabilities,
} from "../correct.ts";
import { itemAction, resource } from "../define.ts";
import { allocationCapabilities, allocationResources } from "./parts/allocations.ts";
import { rosterEntryCapabilities, rosterEntryResources } from "./parts/roster-project-facts.ts";

const SINCE = "1.0.0-draft.2";

const ReviewOutcome = z.enum(["Accepted", "Returned"]);

const reviewBody = z
  .object({
    outcome: ReviewOutcome.meta({
      description: "Accepted, or Returned to the recipient to answer again.",
      example: "Returned",
    }),
    return_reason: z.string().min(1).max(1000).optional().meta({
      description: "Why the answer is returned; required when Returned, shown to the recipient.",
      example: "Please add the flight number.",
    }),
  })
  .meta({ id: "AdvanceSubmissionReviewRequest", description: "Review of one advance answer." });

const GuestState = z.enum(["Requested", "Approved", "Declined", "Checked In"]);

/**
 * app.guest_list_entries (0431, 0965). The audit people are nullable, as ADR 0023 made them for
 * every frozen resource: seed, platform and Gateway-token rows carry no person.
 */
const GuestListEntry = editDefinition(
  defineResource({
    name: "GuestListEntry",
    table: "app.guest_list_entries",
    description:
      "A guest on a project's guest list with plus-ones. Requested guests are approved or declined by someone with review authority who did not request them, then checked in at the door.",
    fields: {
      project_id: fields.ref("project"),
      scope_node_id: orNull(fields.ref("show or other scope node of the same project")),
      person_id: orNull(fields.ref("person whose list the guest is on")),
      counterparty_id: orNull(fields.ref("organization whose list the guest is on")),
      engagement_id: orNull(fields.ref("engagement the guest was requested under in Gateway")),
      guest_name: fields.text("Name the guest gives at the door.", "Jordan Pike", 200),
      plus_ones: fields.int("Additional guests admitted with this guest, 0 to 20.", 1),
      note: orNull(fields.text("Notes for the door.", "Side stage.", 500)),
      entry_state: GuestState.meta({
        description:
          "Requested, Approved, Declined or Checked In; moved by the decide and check-in actions.",
        example: "Requested",
      }),
      decided_at: orNull(
        fields.instant("When the request was approved or declined. Set by the database."),
      ),
      decided_by: orNull(fields.ref("person who decided, set by the database")),
      checked_in_at: orNull(fields.instant("When the guest was checked in. Set by the database.")),
      checked_in_by: orNull(fields.ref("person who checked the guest in, set by the database")),
    },
    serverSet: [
      "person_id",
      "counterparty_id",
      "engagement_id",
      "entry_state",
      "decided_at",
      "decided_by",
      "checked_in_at",
      "checked_in_by",
    ],
    immutable: ["project_id"],
  }),
  { nullable: ["created_by", "updated_by"] },
);

export const additions = defineAdditions("Advancing", {
  resources: [
    ...rosterEntryResources,
    ...allocationResources,
    resource("Advancing", "/guest-list-entries", GuestListEntry, {
      actions: [
        itemAction("decide", {
          summary: "Approve or decline a guest",
          description:
            "Moves a Requested guest to Approved or Declined. Needs review authority on the project and refuses the person who requested the guest (sod_guest_requester, 422); the database stamps who decided and when.",
          body: z
            .object({
              outcome: z.enum(["Approved", "Declined"]).meta({
                description: "Approved or Declined.",
                example: "Approved",
              }),
            })
            .meta({ id: "GuestDecisionRequest", description: "Decision on a requested guest." }),
        }),
        itemAction("checkIn", {
          summary: "Check a guest in",
          description:
            "Moves an Approved guest to Checked In at the door; the database stamps who checked them in and when. Any other state is refused (422).",
        }),
      ],
    }),
  ],
  capabilities: {
    ...rosterEntryCapabilities,
    ...allocationCapabilities,
    guestListEntries: {
      read: "advancing.packet.read",
      write: "advancing.rider.write",
      actions: { decide: "advancing.submission.review", checkIn: "advancing.rider.write" },
    },
  },
  corrections: [
    {
      id: "advance-packet-derived-state",
      since: SINCE,
      resources: ["advancePackets"],
      change:
        "Removes `advance_state` and the `transition` action; `due_at` becomes nullable and optional on create; `sent_at` is set only by the `send` action.",
      reason:
        "app.advance_packets (0351) has no lifecycle column: a packet's state is derived from `sent_at`, `due_at` and its answers, and 0430 lets only app.send_advance_packet set `sent_at`. `due_at` is a nullable column.",
      apply: all(
        editShape({ remove: ["advance_state"], nullable: ["due_at"], serverSet: ["sent_at"] }),
        removeActions("transition"),
      ),
    },
    {
      id: "advance-section-prompt",
      since: SINCE,
      resources: ["advanceSections"],
      change:
        "Replaces `form_definition_id` with `prompt`, the question put to recipients (nullable).",
      reason:
        "app.advance_sections (0351) stores the section's prompt as text; there is no form definition table. 0430 fixes the section list of a sent packet.",
      apply: editShape({
        remove: ["form_definition_id"],
        add: {
          prompt: {
            schema: orNull(
              fields.text("What the recipient is asked.", "When does the party arrive?", 2000),
            ),
            create: "optional",
          },
        },
      }),
    },
    {
      id: "advance-recipient-party",
      since: SINCE,
      resources: ["advanceRecipients"],
      change:
        "Replaces `organization_id` and `engagement_id` with `counterparty_id`; a recipient is exactly one of a person or a counterparty.",
      reason:
        "app.advance_recipients (0351) binds a recipient to a person or to a counterparty (the org-side relationship row, Section 3.15 item 4), with a check that exactly one is set.",
      apply: editShape({
        remove: ["organization_id", "engagement_id"],
        add: {
          counterparty_id: {
            schema: orNull(fields.ref("recipient counterparty")),
            create: "optional",
          },
        },
      }),
    },
    {
      id: "advance-submission-answer-and-review",
      since: SINCE,
      resources: ["advanceSubmissions"],
      components: ["schemas/AdvanceSubmissionReviewRequest"],
      change:
        "Replaces `form_submission_id` with the answer `body` (required on create); adds the server-set review (`reviewed_at`, `reviewed_by`, `review_outcome`, `return_reason`) and `via_link`; create needs review authority; adds the `review` action.",
      reason:
        "app.advance_submissions (0351, 0430) stores the answer as text and its one review as Accepted or Returned with a reason, stamped by the database and refused for the submitter (sod_advance_submitter). Recipients answer through Gateway (api_public.submit_advance); recording an answer in Atlas needs advancing.submission.review (0351 insert policy).",
      apply: all(
        editShape({
          remove: ["form_submission_id"],
          serverSet: ["submitted_at"],
          add: {
            body: {
              schema: fields.longText("The answer as rich text.", "Party of 8 lands at 14:20."),
              create: "required",
              update: false,
            },
            reviewed_at: { schema: orNull(fields.instant("When the answer was reviewed.")) },
            reviewed_by: { schema: orNull(fields.ref("person who reviewed the answer")) },
            review_outcome: {
              schema: orNull(
                ReviewOutcome.meta({ description: "Accepted or Returned.", example: "Accepted" }),
              ),
            },
            return_reason: {
              schema: orNull(
                fields.text("Why the answer was returned.", "Please add the flight number.", 1000),
              ),
            },
            via_link: {
              schema: fields.bool(
                "True when the recipient answered through a Gateway link.",
                false,
              ),
            },
          },
        }),
        putActions(
          [
            itemAction("review", {
              summary: "Review an advance answer",
              description:
                "Records the one review of an answer: Accepted, or Returned with a reason the recipient reads. The database stamps the reviewer and time and refuses the person who submitted it (sod_advance_submitter) or a second review (422).",
              body: reviewBody,
            }),
          ],
          { review: "advancing.submission.review" },
        ),
        setCapabilities({ create: "advancing.submission.review" }),
      ),
    },
    {
      id: "advance-promotion-record",
      since: SINCE,
      resources: ["advancePromotions"],
      change: "`target_urn` becomes `record_id`, the record the answer was promoted into.",
      reason:
        "app.advance_promotions (0351) links an answer to an app.records row by foreign key, not by URN.",
      apply: editShape({
        remove: ["target_urn"],
        add: {
          record_id: { schema: fields.ref("record created from the answer"), create: "required" },
        },
      }),
    },
    {
      id: "rider-project-and-party",
      since: SINCE,
      resources: ["riders"],
      change:
        "Replaces `engagement_id` with `project_id` (required on create, immutable) and the optional `counterparty_id`; removes `document_id`.",
      reason:
        "app.riders (0351) belongs to a project and optionally to the counterparty whose rider it is; files attach through the attachment service (0590), not a document column.",
      apply: editShape({
        remove: ["engagement_id", "document_id"],
        add: {
          project_id: { schema: fields.ref("project"), create: "required", update: false },
          counterparty_id: {
            schema: orNull(fields.ref("counterparty whose rider it is")),
            create: "optional",
          },
        },
      }),
    },
    {
      id: "rider-line-ask",
      since: SINCE,
      resources: ["riderLines"],
      change:
        "`statement` becomes `description` (up to 500 characters); removes `urid` and `requirement_id`; adds the optional `element_id` and `fulfilled_at`.",
      reason:
        "app.rider_lines (0351) stores each ask's description, an optional catalog element, a nullable quantity and when it was fulfilled (NULL while open); requirements live in app.capability_statements.",
      apply: editShape({
        remove: ["statement", "urid", "requirement_id"],
        add: {
          description: {
            schema: fields.text("What is asked.", "Two wedge monitors per vocalist.", 500),
            create: "required",
          },
          element_id: {
            schema: orNull(
              fields.text("Catalog element that fulfills the ask.", "5000.02.01-NWL-001", 64),
            ),
            create: "optional",
          },
          fulfilled_at: {
            schema: orNull(fields.instant("When the ask was fulfilled; NULL while open.")),
            create: "optional",
          },
        },
      }),
    },
  ],
});
