/**
 * Knowledge handlers (A16): SOPs with publishing and self-acknowledgment, documents with
 * append-only versions, and the verbiage library. Every read and write runs as the caller, so row
 * level security and the 0353 guards decide (versions and acknowledgments never change; verbiage
 * refuses em dashes). Shapes follow catalog/modules/knowledge.ts (ADR 0023).
 */
import { publishSop } from "@xos/data/knowledge";
import { badRequest } from "../problem.ts";
import { defineHandlers, ok } from "../runtime/handler.ts";
import { handlersFor, tableResource, unwrap } from "./support/table.ts";

const sops = tableResource("sops");

export const handlers = defineHandlers("Knowledge", {
  ...handlersFor("Knowledge", sops),
  ...handlersFor(
    "Knowledge",
    tableResource("sopAcknowledgments", {
      // An acknowledgment is always the caller's own (guard_sop_acknowledgment).
      beforeCreate: (_body, context) => {
        if (context.personId === null) {
          throw badRequest("Acknowledging an SOP needs a signed-in person.");
        }
        return { person_id: context.personId };
      },
    }),
  ),
  ...handlersFor("Knowledge", tableResource("documents")),
  ...handlersFor("Knowledge", tableResource("documentVersions")),
  ...handlersFor("Knowledge", tableResource("verbiageTerms")),

  "sops.publish": async ({ params }, context) => {
    await sops.read(context, params.id, ["id"]);
    unwrap(await publishSop(context.db, params.id));
    return ok((await sops.read(context, params.id)) as never);
  },
});
