/**
 * Knowledge handlers (A16): SOPs with publishing and self-acknowledgment, documents with
 * append-only versions, and the verbiage library. Every read and write runs as the caller, so row
 * level security and the 0353 guards decide (versions and acknowledgments never change; verbiage
 * refuses em dashes). Shapes follow catalog/modules/knowledge.ts (ADR 0023).
 */
import { publishSop } from "@xos/data/knowledge";
import { badRequest } from "../problem.ts";
import { defineHandlers, ok } from "../runtime/handler.ts";
import { fieldHistory } from "./parts/bulk-edit-and-history.ts";
import { from, handlersFor, run, tableResource, unwrap } from "./support/table.ts";

const sops = tableResource("sops");
const documents = tableResource("documents");

interface NotesSnapshot {
  readonly generation: number;
  readonly through_seq: number;
  readonly last_seq: number;
  readonly text_snapshot: string | null;
}

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
  ...handlersFor("Knowledge", documents),
  ...handlersFor("Knowledge", tableResource("documentVersions")),
  ...handlersFor("Knowledge", tableResource("verbiageTerms")),

  "sops.publish": async ({ params }, context) => {
    await sops.read(context, params.id, ["id"]);
    unwrap(await publishSop(context.db, params.id));
    return ok((await sops.read(context, params.id)) as never);
  },

  // Field history (A106, migration 1452).
  "sops.fieldHistory": async ({ params, query }, context) =>
    ok((await fieldHistory(context, "app.sops", params.id, query.limit)) as never),
  "documents.fieldHistory": async ({ params, query }, context) =>
    ok((await fieldHistory(context, "app.documents", params.id, query.limit)) as never),

  /**
   * A document's co-edited notes as plain text (A106, migration 1453): the snapshot's text as the editor last saved
   * it. The document's own read policy decides first; the snapshot follows the same row (private.coedit_can_read).
   */
  "documents.notes": async ({ params }, context) => {
    await documents.read(context, params.id, ["id"]);
    const doc = await run<NotesSnapshot | null>(
      from(context.db, "doc_snapshots")
        .select("generation,through_seq,last_seq,text_snapshot")
        .eq("subject_table", "app.documents")
        .eq("subject_id", params.id)
        .eq("doc_key", "notes")
        .is("deleted_at", null)
        .maybeSingle(),
    );
    return ok({
      document_id: params.id,
      text: doc?.text_snapshot ?? null,
      generation: doc?.generation ?? 0,
      saved_through: Number(doc?.through_seq ?? 0),
      latest_edit: Number(doc?.last_seq ?? 0),
    } as never);
  },
});
