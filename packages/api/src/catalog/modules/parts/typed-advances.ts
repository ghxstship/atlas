/**
 * Typed advance sections in the public API (R9, RRR-189; migrations 2710 to 2716). Additive only (v1 is frozen,
 * Section 10.1):
 *
 *   * `advanceSectionChoices`: the asset classes an Item Request offers and the credential categories a Credential
 *     Request offers (app.advance_section_choices), created and removed while the packet is a draft.
 *   * `advanceSubmissionLines` and `advanceSubmissionFiles`: the lines and files of typed answers, read only; they are
 *     written with the answer by app.submit_advance_answer in Gateway.
 *
 * The section kind and the recipient's engagement and naming deadline enter the frozen `advanceSections` and
 * `advanceRecipients` through correction entries in catalog/modules/advancing.ts, with their actions.
 */
import { z } from "@hono/zod-openapi";
import { defineResource, fields } from "@xos/schemas";
import type { CapabilityRule } from "../../capabilities.ts";
import { editDefinition, orNull } from "../../correct.ts";
import { resource } from "../../define.ts";
import type { ResourceSpec } from "../../types.ts";

export const SECTION_KINDS = [
  "Text",
  "File",
  "Schedule Window",
  "Item Request",
  "Crew Roster",
  "Guest List",
  "Credential Request",
] as const;
export const WINDOW_KINDS = [
  "Load In",
  "Load Out",
  "Arrival",
  "Soundcheck",
  "Activation Setup",
  "Activation Strike",
] as const;

const AdvanceSectionChoice = editDefinition(
  defineResource({
    name: "AdvanceSectionChoice",
    table: "app.advance_section_choices",
    description:
      "What an Item Request or Credential Request section offers (R9): an asset class of the org that answers for an offering (radios, carts), or a credential category of the packet's project. Exactly one of the two is set. Choices are added and removed only while the packet is a draft (advance_packet_sections_fixed, 422).",
    fields: {
      advance_section_id: fields.ref("section the choice belongs to"),
      asset_class_id: orNull(fields.ref("asset class an Item Request offers")),
      credential_category_id: orNull(fields.ref("credential category a Credential Request offers")),
    },
    immutable: ["advance_section_id", "asset_class_id", "credential_category_id"],
  }),
  { nullable: ["created_by", "updated_by"] },
);

const AdvanceSubmissionLine = editDefinition(
  defineResource({
    name: "AdvanceSubmissionLine",
    table: "app.advance_submission_lines",
    description:
      "A line of a typed advance answer (R9): a window of a Schedule Window section, or an asset class or credential category with a quantity, optionally for one person on the engagement's roster and for a window. Written with the answer in Gateway; never changes.",
    fields: {
      advance_submission_id: fields.ref("answer the line belongs to"),
      line_number: fields.int("Order in the answer, 1 to 50.", 1, 1),
      asset_class_id: orNull(fields.ref("asset class asked for")),
      credential_category_id: orNull(fields.ref("credential category asked for")),
      roster_entry_id: orNull(fields.ref("roster entry of the person the line is for")),
      quantity: orNull(fields.int("How many, 1 to 10000.", 6, 1)),
      needed_window: orNull(
        z.string().meta({
          description: "When it is needed, as a Postgres tstzrange literal.",
          example: '["2027-06-01 08:00:00+00","2027-06-01 10:00:00+00")',
        }),
      ),
      window_zone: orNull(fields.timeZone("IANA time zone of the window.")),
      note: orNull(fields.text("Note on the line.", "Delivered to the FOH riser.", 500)),
    },
    serverSet: [
      "advance_submission_id",
      "line_number",
      "asset_class_id",
      "credential_category_id",
      "roster_entry_id",
      "quantity",
      "needed_window",
      "window_zone",
      "note",
    ],
  }),
  { nullable: ["created_by", "updated_by"] },
);

const AdvanceSubmissionFile = editDefinition(
  defineResource({
    name: "AdvanceSubmissionFile",
    table: "app.advance_submission_files",
    description:
      "A file of a File answer (R9): a document uploaded to the party-uploads bucket under the recipient and section and registered, attached to one answer. Written with the answer in Gateway; never changes.",
    fields: {
      advance_submission_id: fields.ref("answer the file belongs to"),
      document_id: fields.ref("document of the uploaded file"),
      position: fields.int("Order in the answer, 1 to 10.", 1, 1),
    },
    serverSet: ["advance_submission_id", "document_id", "position"],
  }),
  { nullable: ["created_by", "updated_by"] },
);

export const typedAdvanceResources: readonly ResourceSpec[] = [
  resource("Advancing", "/advance-section-choices", AdvanceSectionChoice, {
    verbs: ["list", "get", "create", "delete"],
  }),
  resource("Advancing", "/advance-submission-lines", AdvanceSubmissionLine, {
    verbs: ["list", "get"],
  }),
  resource("Advancing", "/advance-submission-files", AdvanceSubmissionFile, {
    verbs: ["list", "get"],
  }),
];

export const typedAdvanceCapabilities: Readonly<Record<string, CapabilityRule>> = {
  advanceSectionChoices: { read: "advancing.packet.read", write: "advancing.packet.write" },
  advanceSubmissionLines: { read: "advancing.packet.read" },
  advanceSubmissionFiles: { read: "advancing.packet.read" },
};
