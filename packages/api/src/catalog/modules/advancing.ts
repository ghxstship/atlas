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
import {
  SECTION_KINDS,
  WINDOW_KINDS,
  typedAdvanceCapabilities,
  typedAdvanceResources,
} from "./parts/typed-advances.ts";

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
    ...typedAdvanceResources,
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
    ...typedAdvanceCapabilities,
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
      id: "advance-section-kinds",
      since: SINCE,
      resources: ["advanceSections"],
      components: ["schemas/AdvanceSectionConfigureRequest"],
      change:
        "Adds `section_kind`, `window_kind`, `max_lines` and `per_person`, optional on create, and the `configure` action that changes them while the packet is a draft.",
      reason:
        "app.advance_sections (2710, R9) stores the section kind (Text, File, Schedule Window, Item Request, Crew Roster, Guest List or Credential Request) and its configuration, held to the kind by advance_sections_kind_fields and fixed once the packet is sent (advance_packet_sections_fixed).",
      apply: all(
        editShape({
          add: {
            section_kind: {
              schema: z.enum(SECTION_KINDS).meta({
                description: "What the section asks for; Text unless given.",
                example: "Item Request",
              }),
              create: "optional",
              update: false,
            },
            window_kind: {
              schema: orNull(
                z.enum(WINDOW_KINDS).meta({
                  description: "For a Schedule Window section, what the window is.",
                  example: "Load In",
                }),
              ),
              create: "optional",
              update: false,
            },
            max_lines: {
              schema: orNull(
                fields.int(
                  "Most files (1 to 10), windows (1 to 5) or lines (1 to 50) of one answer.",
                  6,
                  1,
                ),
              ),
              create: "optional",
              update: false,
            },
            per_person: {
              schema: fields.bool(
                "For an Item Request or Credential Request, true when every line names one person on the roster.",
                false,
              ),
              create: "optional",
              update: false,
            },
          },
        }),
        putActions(
          [
            itemAction("configure", {
              summary: "Configure an advance section",
              description:
                "Sets a draft section's kind and configuration. The kind decides which of window_kind, max_lines and per_person apply (23514 as 422 otherwise); a sent packet's sections are fixed (advance_packet_sections_fixed, 422), and a section with choices keeps its kind (advance_section_kind_choices, 422).",
              body: z
                .object({
                  section_kind: z
                    .enum(SECTION_KINDS)
                    .meta({ description: "Section kind.", example: "Schedule Window" }),
                  window_kind: z.enum(WINDOW_KINDS).nullable().optional().meta({
                    description: "Window kind, for a Schedule Window.",
                    example: "Load In",
                  }),
                  max_lines: z
                    .number()
                    .int()
                    .min(1)
                    .max(50)
                    .nullable()
                    .optional()
                    .meta({ description: "Most lines or files of one answer.", example: 2 }),
                  per_person: z
                    .boolean()
                    .optional()
                    .meta({ description: "Every line names a person.", example: false }),
                })
                .meta({
                  id: "AdvanceSectionConfigureRequest",
                  description: "The kind and configuration of a section.",
                }),
            }),
          ],
          { configure: "advancing.packet.write" },
        ),
      ),
    },
    {
      id: "advance-recipient-engagement",
      since: SINCE,
      resources: ["advanceRecipients"],
      components: [
        "schemas/AdvanceRecipientBindEngagementRequest",
        "schemas/AdvanceRecipientSetNamesDueRequest",
      ],
      change:
        "Adds `engagement_id`, the engagement the recipient answers under, and `names_due_at`, the naming deadline (both optional on create), with the `bindEngagement` and `setNamesDue` actions.",
      reason:
        "app.advance_recipients.engagement_id (2710, R9) links a recipient to a live engagement of the same party on the packet's project, fixed once the packet is sent (advance_recipient_engagement); names_due_at (2716, G-141) is when the party stops naming people on requested passes, only with an engagement and editable after send.",
      apply: all(
        editShape({
          add: {
            engagement_id: {
              schema: orNull(fields.ref("engagement the recipient answers under")),
              create: "optional",
              update: false,
            },
            names_due_at: {
              schema: orNull(
                fields.instant(
                  "When the party stops naming people on the passes it requested through this recipient.",
                ),
              ),
              create: "optional",
              update: false,
            },
          },
        }),
        putActions(
          [
            itemAction("bindEngagement", {
              summary: "Link a recipient to its engagement",
              description:
                "Sets or clears the engagement a draft packet's recipient answers under: a live engagement of the same party on the packet's project (advance_recipient_engagement, 422); fixed once the packet is sent.",
              body: z
                .object({
                  engagement_id: z.uuid().nullable().meta({
                    description: "The engagement, or null to clear it.",
                    example: "01920000-0000-7000-8000-000000000001",
                  }),
                })
                .meta({
                  id: "AdvanceRecipientBindEngagementRequest",
                  description: "The engagement a recipient answers under.",
                }),
            }),
            itemAction("setNamesDue", {
              summary: "Set a recipient's naming deadline",
              description:
                "Sets or clears when the party stops naming, renaming and unnaming people on the passes it requested through this recipient (G-141). Production can still change them afterwards. Needs an engagement (advance_recipients_names_due_engagement, 422); editable after the packet is sent.",
              body: z
                .object({
                  names_due_at: z.iso.datetime({ offset: true }).nullable().meta({
                    description: "The deadline, or null to clear it.",
                    example: "2027-05-20T23:59:00Z",
                  }),
                })
                .meta({
                  id: "AdvanceRecipientSetNamesDueRequest",
                  description: "A recipient's naming deadline.",
                }),
            }),
          ],
          { bindEngagement: "advancing.packet.write", setNamesDue: "advancing.packet.write" },
        ),
      ),
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
