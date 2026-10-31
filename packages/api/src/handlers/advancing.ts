/**
 * Advancing handlers (A10, RRR-22): packets, sections, recipients, answers and their review,
 * promotions, riders and rider lines, and guest lists. Every read and write runs as the caller, so
 * row level security and the 0430 and 0431 guards decide; sending, reviewing and guest decisions go
 * through the same repository functions Atlas uses, whose refusals come back as 422 with the rule.
 * See packages/api/README.md and ADR 0023 (the Advancing corrections in catalog/modules/advancing.ts).
 */
import {
  bindRecipientEngagement,
  checkInGuest,
  configureSection,
  decideGuest,
  reviewSubmission,
  sectionConfig,
  sendPacket,
  setRecipientNamesDue,
} from "@xos/data/advancing";
import { badRequest } from "../problem.ts";
import { requirePerson } from "../runtime/context.ts";
import { defineHandlers, ok } from "../runtime/handler.ts";
import { allocationHandlers } from "./parts/allocations.ts";
import { rosterEntryHandlers } from "./parts/roster-project-facts.ts";
import { handlersFor, tableResource, unwrap } from "./support/table.ts";

const packets = tableResource("advancePackets");
const sections = tableResource("advanceSections");
const recipients = tableResource("advanceRecipients");
const submissions = tableResource("advanceSubmissions", {
  derived: ["via_link"],
  extraColumns: ["advance_recipient_token_id"],
  toContract: (row) => ({ ...row, via_link: (row["advance_recipient_token_id"] ?? null) !== null }),
});
const promotions = tableResource("advancePromotions", { softDelete: false });
const riders = tableResource("riders");
const riderLines = tableResource("riderLines");
const guests = tableResource("guestListEntries");
// R9: section choices, and the lines and files of typed answers.
const choices = tableResource("advanceSectionChoices");
const answerLines = tableResource("advanceSubmissionLines");
const answerFiles = tableResource("advanceSubmissionFiles");

export const handlers = defineHandlers("Advancing", {
  ...handlersFor("Advancing", packets),
  ...handlersFor("Advancing", sections),
  ...handlersFor("Advancing", recipients),
  ...handlersFor("Advancing", submissions),
  ...handlersFor("Advancing", promotions),
  ...handlersFor("Advancing", riders),
  ...handlersFor("Advancing", riderLines),
  ...handlersFor("Advancing", guests),
  ...handlersFor("Advancing", choices),
  ...handlersFor("Advancing", answerLines),
  ...handlersFor("Advancing", answerFiles),
  // Roster entries and their project facts (R5): see ./parts/roster-project-facts.ts.
  ...rosterEntryHandlers,
  // Advance allocations (R7): see ./parts/allocations.ts.
  ...allocationHandlers,

  "advancePackets.send": async ({ params }, context) => {
    await packets.read(context, params.id, ["id"]);
    unwrap(await sendPacket(context.db, params.id));
    return ok((await packets.read(context, params.id)) as never);
  },

  "advanceSections.configure": async ({ params, body }, context) => {
    await sections.read(context, params.id, ["id"]);
    const config = sectionConfig({
      kind: body.section_kind,
      windowKind: body.window_kind ?? null,
      maxLines: body.max_lines ?? null,
      perPerson: body.per_person ?? false,
    });
    if (config === null) throw badRequest("The configuration does not fit the section kind.");
    unwrap(await configureSection(context.db, params.id, config));
    return ok((await sections.read(context, params.id)) as never);
  },

  "advanceRecipients.bindEngagement": async ({ params, body }, context) => {
    await recipients.read(context, params.id, ["id"]);
    unwrap(await bindRecipientEngagement(context.db, params.id, body.engagement_id));
    return ok((await recipients.read(context, params.id)) as never);
  },

  "advanceRecipients.setNamesDue": async ({ params, body }, context) => {
    await recipients.read(context, params.id, ["id"]);
    unwrap(await setRecipientNamesDue(context.db, params.id, body.names_due_at));
    return ok((await recipients.read(context, params.id)) as never);
  },

  "advanceSubmissions.review": async ({ params, body }, context) => {
    await submissions.read(context, params.id, ["id"]);
    unwrap(
      await reviewSubmission(context.db, {
        submissionId: params.id,
        reviewerPersonId: requirePerson(context),
        outcome: body.outcome,
        returnReason: body.return_reason ?? null,
      }),
    );
    return ok((await submissions.read(context, params.id)) as never);
  },

  "guestListEntries.decide": async ({ params, body }, context) => {
    await guests.read(context, params.id, ["id"]);
    unwrap(await decideGuest(context.db, params.id, body.outcome));
    return ok((await guests.read(context, params.id)) as never);
  },

  "guestListEntries.checkIn": async ({ params }, context) => {
    await guests.read(context, params.id, ["id"]);
    unwrap(await checkInGuest(context.db, params.id));
    return ok((await guests.read(context, params.id)) as never);
  },
});
