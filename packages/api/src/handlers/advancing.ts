/**
 * Advancing handlers (A10, RRR-22): packets, sections, recipients, answers and their review,
 * promotions, riders and rider lines, and guest lists. Every read and write runs as the caller, so
 * row level security and the 0430 and 0431 guards decide; sending, reviewing and guest decisions go
 * through the same repository functions Atlas uses, whose refusals come back as 422 with the rule.
 * See packages/api/README.md and ADR 0023 (the Advancing corrections in catalog/modules/advancing.ts).
 */
import { checkInGuest, decideGuest, reviewSubmission, sendPacket } from "@xos/data/advancing";
import { requirePerson } from "../runtime/context.ts";
import { defineHandlers, ok } from "../runtime/handler.ts";
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

export const handlers = defineHandlers("Advancing", {
  ...handlersFor("Advancing", packets),
  ...handlersFor("Advancing", sections),
  ...handlersFor("Advancing", recipients),
  ...handlersFor("Advancing", submissions),
  ...handlersFor("Advancing", promotions),
  ...handlersFor("Advancing", riders),
  ...handlersFor("Advancing", riderLines),
  ...handlersFor("Advancing", guests),

  "advancePackets.send": async ({ params }, context) => {
    await packets.read(context, params.id, ["id"]);
    unwrap(await sendPacket(context.db, params.id));
    return ok((await packets.read(context, params.id)) as never);
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
